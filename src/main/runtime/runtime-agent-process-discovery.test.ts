import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as processTableSnapshotReader from '../../shared/process-table-snapshot-reader'
import { createEphemeralAgentSessionClaimSigner } from './agent-session-claim-identity'
import { agentSessionOwners } from '../ipc/pty/pane/agent-session-owners'
import {
  admitRuntimeAgentProcessDiscoveries,
  resolveRuntimeAgentDiscoveryProviderIdentity
} from './runtime-agent-process-discovery'

const { readSnapshot } = vi.hoisted(() => ({ readSnapshot: vi.fn() }))

vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof processTableSnapshotReader>()),
  getStrictProcessTableSnapshotWithAge: readSnapshot
}))

const signer = createEphemeralAgentSessionClaimSigner('runtime-process-discovery-test')
let providerIdentity = {
  agent: 'codex' as const,
  source: 'provider-session' as const,
  session: { key: 'session_id' as const, id: 'codex-session-1' },
  observation: {
    authorityId: 'hooks-1',
    incarnation: 1,
    revision: 1,
    process: { pid: 200, startTime: 'agent-start-1' }
  }
}
const candidate = {
  ptyId: 'pty-manual',
  ptyIncarnationId: '22222222-2222-4222-8222-222222222222',
  rootProcessId: 100,
  surface: {
    worktreeId: 'repo::/workspace',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminalHandle: `term_${'a'.repeat(32)}`
  },
  resolveProviderIdentity: () => providerIdentity,
  invalidateProviderIdentity: vi.fn(),
  isCurrent: () => true
}

function rows(processPid: number, processStart: string): ProcessTableRow[] {
  return [
    {
      pid: 100,
      ppid: 1,
      pgid: 100,
      tpgid: processPid,
      tty: '/dev/pts/1',
      startTime: 'shell-start',
      stat: 'Ss',
      command: '/bin/zsh'
    },
    {
      pid: processPid,
      ppid: 100,
      pgid: processPid,
      tpgid: processPid,
      tty: '/dev/pts/1',
      startTime: processStart,
      stat: 'S+',
      command: '/usr/local/bin/codex'
    }
  ]
}

async function run(table: ProcessTableRow[], providerRevision = 1) {
  const agentRow = table.find((row) => row.command.includes('codex'))
  providerIdentity = {
    ...providerIdentity,
    observation: {
      ...providerIdentity.observation,
      revision: providerRevision,
      process: {
        pid: agentRow?.pid ?? providerIdentity.observation.process.pid,
        startTime: agentRow?.startTime ?? providerIdentity.observation.process.startTime
      }
    }
  }
  readSnapshot.mockResolvedValue({ rows: table, capturedAgeMs: 0 })
  const onCommitted = vi.fn()
  const onReconciled = vi.fn()
  await admitRuntimeAgentProcessDiscoveries({
    candidates: [candidate],
    authorityGeneration: signer.keyId,
    observationEpoch: 1,
    platform: 'linux',
    createClaim: ({ agent, launchIdentity, canonicalWorktreeId }) =>
      signer.createFreshClaim({
        namespace: {
          machine: 'native:linux',
          principal: 'uid:1',
          container: 'native',
          providerRoot: `profile-default:${agent}`
        },
        agent,
        launchIdentity,
        canonicalWorktreeId
      }),
    onCommitted,
    onReconciled
  })
  return { onCommitted, onReconciled }
}

afterEach(() => {
  agentSessionOwners.release(candidate.ptyId)
  readSnapshot.mockReset()
  candidate.invalidateProviderIdentity.mockReset()
  providerIdentity = {
    ...providerIdentity,
    observation: { ...providerIdentity.observation, revision: 1 }
  }
})

describe('runtime agent process discovery', () => {
  it('joins provider proof only to the exact observed terminal and PTY incarnation', () => {
    const readProviderIdentity = vi.fn(() => providerIdentity)
    const exact = resolveRuntimeAgentDiscoveryProviderIdentity({
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      terminalHandle: candidate.surface.terminalHandle,
      processIncarnation: `${candidate.ptyId}:${candidate.ptyIncarnationId}`,
      readObserved: () => ({
        kind: 'observed',
        terminalHandle: candidate.surface.terminalHandle,
        processIncarnation: `${candidate.ptyId}:${candidate.ptyIncarnationId}`,
        dispatchId: null
      }),
      readProviderIdentity
    })
    const stale = resolveRuntimeAgentDiscoveryProviderIdentity({
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      terminalHandle: candidate.surface.terminalHandle,
      processIncarnation: `${candidate.ptyId}:new-incarnation`,
      readObserved: () => ({
        kind: 'observed',
        terminalHandle: candidate.surface.terminalHandle,
        processIncarnation: `${candidate.ptyId}:${candidate.ptyIncarnationId}`,
        dispatchId: null
      }),
      readProviderIdentity
    })

    expect(exact).toBe(providerIdentity)
    expect(stale).toBeNull()
    expect(readProviderIdentity).toHaveBeenCalledOnce()
  })

  it('admits, replaces, and retires a manual process from complete host captures', async () => {
    const firstRun = await run(rows(200, 'agent-start-1'))
    const first = agentSessionOwners.listForPty(candidate.ptyId)[0]
    expect(firstRun.onCommitted).toHaveBeenCalledOnce()
    expect(first).toMatchObject({
      discoveryProcess: { pid: 200, startTime: 'agent-start-1' },
      claim: { agent: 'codex' }
    })

    const secondRun = await run(rows(201, 'agent-start-2'), 2)
    const second = agentSessionOwners.listForPty(candidate.ptyId)[0]
    expect(secondRun.onCommitted).toHaveBeenCalledOnce()
    expect(second).toMatchObject({
      discoveryProcess: { pid: 201, startTime: 'agent-start-2' },
      statusBinding: { continuityOf: first?.statusBinding.runId }
    })
    expect(second?.generation).not.toBe(first?.generation)

    agentSessionOwners.release(candidate.ptyId, first?.generation)
    expect(agentSessionOwners.listForPty(candidate.ptyId)).toEqual([second])

    const retired = await run(
      rows(202, 'ordinary-start').map((row, index) =>
        index === 1 ? { ...row, command: 'vim notes.txt' } : row
      )
    )
    expect(retired.onCommitted).not.toHaveBeenCalled()
    expect(retired.onReconciled).toHaveBeenLastCalledWith([])
    expect(agentSessionOwners.listForPty(candidate.ptyId)).toEqual([])
  })

  it('does not mutate ownership when the host process table is unverifiable', async () => {
    await run(rows(200, 'agent-start-1'))
    const before = agentSessionOwners.listForPty(candidate.ptyId)
    readSnapshot.mockRejectedValue(new Error('process_table_unreadable'))

    await expect(
      admitRuntimeAgentProcessDiscoveries({
        candidates: [candidate],
        authorityGeneration: signer.keyId,
        observationEpoch: 2,
        platform: 'linux',
        createClaim: ({ agent, launchIdentity, canonicalWorktreeId }) =>
          signer.createFreshClaim({
            namespace: {
              machine: 'native:linux',
              principal: 'uid:1',
              container: 'native',
              providerRoot: `profile-default:${agent}`
            },
            agent,
            launchIdentity,
            canonicalWorktreeId
          }),
        onCommitted: vi.fn(),
        onReconciled: vi.fn()
      })
    ).rejects.toThrow('process_table_unreadable')
    expect(agentSessionOwners.listForPty(candidate.ptyId)).toEqual(before)
  })
})
