/**
 * Adoption against the REAL `agentSessionPtyWriteGate`.
 *
 * Every other adoption test mocks the PTY controller, so `writeAgentSessionProof` answers whatever
 * the mock says and `admitProof` never runs — which is precisely why they all passed while no user
 * could ever switch a Codex tab to structured chat. Here the controller delegates to the real gate
 * over a real record store, so the probe is admitted only when adoption has actually reserved the
 * lease and bound the pane first.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-runtime'
import { OrcaRuntimeService } from './orca-runtime'

const { readStructuredTuiProcessIdentity } = vi.hoisted(() => ({
  readStructuredTuiProcessIdentity: vi.fn()
}))
// The only OS-dependent step in the flow; the rollout proof and the write gate both stay real.
vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity }))

const WORKTREE_ID = 'repo-1::/tmp/structured-adoption'
const PTY_ID = 'pty-adopt'
const PANE_KEY = 'tab-adopt:leaf-adopt'
const THREAD_ID = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const SESSION_ID = `codex_${THREAD_ID.replaceAll('-', '_')}`

type ProofRig = {
  runtime: OrcaRuntimeService
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  proofWrites: string[]
  refusedWrites: string[]
  codexHome: string
  historyFilePath: ReturnType<typeof vi.fn>
}

let root: string
let rig: ProofRig

async function writeRolloutFixture(codexHome: string, threadId: string): Promise<void> {
  const dir = join(codexHome, 'sessions', '2026', '08', '19')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `rollout-2026-08-19T10-00-00-${threadId}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
    'utf8'
  )
}

/**
 * A PTY that answers `/status` with a Codex session banner — but only for bytes the real gate
 * admitted. This mirrors `writeAgentSessionProof` in src/main/ipc/pty.ts verbatim.
 */
function installProofPty(
  rigState: ProofRig,
  threadId: string,
  ptyRecord: { lastOutputAt: number }
) {
  return (ptyId: string, data: string, authority: { sessionId: string; spawnToken: string }) => {
    if (!agentSessionPtyWriteGate.admitProof(ptyId, authority)) {
      rigState.refusedWrites.push(data)
      return false
    }
    rigState.proofWrites.push(data)
    if (data === '\r') {
      const record = rigState.runtime as unknown as {
        ptysById: Map<string, { tailBuffer: string[]; lastOutputAt: number }>
      }
      const pty = record.ptysById.get(PTY_ID)!
      pty.tailBuffer = [
        '\u001b[2m│  >_ OpenAI Codex (v0.148.0) │',
        `│  Session:                     \u001b[22m${threadId}\u001b[2m │`
      ]
      pty.lastOutputAt = ptyRecord.lastOutputAt + 1_000
    }
    return true
  }
}

async function buildRig(): Promise<ProofRig> {
  const codexHome = join(root, 'codex-home')
  await writeRolloutFixture(codexHome, THREAD_ID)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'agent-sessions'),
    hostId: 'local'
  })
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => store.getRecord(sessionId))
  const historyFilePath = vi.fn(async () => null)
  const host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      historyFilePath
    },
    journalRoot: join(root, 'journals'),
    claimKeyId: 'key-1',
    probeOwner: createStructuredAgentSessionOwnerProbe(
      'local',
      async () => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }),
      async () => []
    )
  })
  setStructuredAgentSessionHost(host)

  const runtime = new OrcaRuntimeService({ getSettings: () => ({ agentDefaultEnv: {} }) } as never)
  const state: ProofRig = {
    runtime,
    store,
    host,
    proofWrites: [],
    refusedWrites: [],
    codexHome,
    historyFilePath
  }
  const ptyRecord = {
    ptyId: PTY_ID,
    connected: true,
    connectionId: null,
    wslDistro: null,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    incarnationId: 'inc-adopt',
    tailBuffer: [] as string[],
    tailPartialLine: '',
    preview: '',
    lastOutputAt: 1_000
  }
  const internal = runtime as unknown as {
    ptysById: Map<string, unknown>
    resolveRuntimeFileTarget(): Promise<unknown>
    resolveStructuredAgentSessionAdoptionIntent(input: { envelope: unknown }): Promise<unknown>
    issueStructuredTuiPtyHandle(): string
  }
  internal.ptysById.set(PTY_ID, ptyRecord)
  internal.resolveRuntimeFileTarget = vi.fn(async () => ({
    connectionId: null,
    worktree: { id: WORKTREE_ID }
  }))
  // Why the adoption intent and not the create one: adoption resolves the pane's OWN account
  // home, which this rig has no pane-account record for. The pane-home resolution itself is
  // covered by orca-runtime-structured-tui-adoption-account-home.test.ts.
  internal.resolveStructuredAgentSessionAdoptionIntent = vi.fn(async ({ envelope }) => ({
    envelope,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKTREE_ID,
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: codexHome },
    runtimeKind: 'native'
  }))
  internal.issueStructuredTuiPtyHandle = vi.fn(() => 'term-adopt')
  runtime.setPtyController({
    listProcesses: async () => [{ id: PTY_ID, incarnationId: 'inc-adopt', rootProcessId: 31337 }],
    writeAgentSessionProof: installProofPty(state, THREAD_ID, ptyRecord)
  } as never)
  return state
}

function adoptInput(overrides: { threadId?: string } = {}) {
  return {
    envelope: {
      sessionId: SESSION_ID,
      clientOperationId: createStructuredAgentSessionOperationId(() => randomUUID()),
      expectedRuntimeFence: null as null,
      payloadFingerprint: 'a'.repeat(64)
    },
    worktree: `id:${WORKTREE_ID}`,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    ptyId: PTY_ID,
    ...overrides
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-adopt-gate-'))
  readStructuredTuiProcessIdentity.mockImplementation(
    async (input: { hostId: string; spawnToken: string }) => ({
      hostId: input.hostId,
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: input.spawnToken
    })
  )
  rig = await buildRig()
})

afterEach(async () => {
  agentSessionPtyWriteGate.unbindPty(PTY_ID)
  agentSessionPtyWriteGate.detachRecordLookup()
  setStructuredAgentSessionHost(null)
  await rig.host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('structured Codex adoption against the real PTY write gate', () => {
  it('authorizes the provider probe, so switching a Codex tab to chat succeeds', async () => {
    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )

    expect(result).toMatchObject({ ok: true })
    // The probe reached the pane: `/status`, submit, escape — none of them refused by the gate.
    expect(rig.refusedWrites).toEqual([])
    expect(rig.proofWrites).toHaveLength(3)
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      lease: { runtimeKind: 'tui', claimStatus: 'live', handoffStage: null }
    })
  }, 20_000)

  it('authorizes the probe when no thread id has been published yet', async () => {
    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), {
      callerKey: 'renderer-1'
    })

    expect(result).toMatchObject({ ok: true })
    expect(rig.refusedWrites).toEqual([])
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      providerHandleChain: [{ origin: 'adopted', handle: { threadId: THREAD_ID } }]
    })
  }, 20_000)

  it('adopts a blank Codex 0.148 session before the lazy rollout exists', async () => {
    await rm(join(rig.codexHome, 'sessions'), { recursive: true, force: true })

    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), {
      callerKey: 'renderer-1'
    })

    expect(result).toMatchObject({ ok: true })
    expect(rig.refusedWrites).toEqual([])
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      providerHandleChain: [{ origin: 'adopted', handle: { threadId: THREAD_ID } }],
      lease: { runtimeKind: 'tui', claimStatus: 'live' }
    })
  }, 20_000)

  it('leaves nothing latched when the proof fails, so the next attempt still succeeds', async () => {
    await rm(join(rig.codexHome, 'sessions'), { recursive: true, force: true })

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('did not prove the expected Codex rollout')
    // The reservation is durably marked as never having spawned, and the pane is released.
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBeNull()
    expect(rig.store.getRecord(SESSION_ID)?.lease).toMatchObject({
      claimStatus: 'reserved',
      ownerProcess: null
    })
    expect(rig.store.getRecord(SESSION_ID)?.lease.processlessAt).toEqual(expect.any(Number))

    await writeRolloutFixture(rig.codexHome, THREAD_ID)
    const retried = await rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )

    expect(retried).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      lease: { claimStatus: 'live', runtimeKind: 'tui' }
    })
  }, 30_000)

  it('deduplicates a replay while a third fresh operation supersedes it', async () => {
    const arrived: string[] = []
    let releaseBoth: () => void = () => {}
    const bothArrived = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    readStructuredTuiProcessIdentity.mockImplementation(
      async (input: { hostId: string; spawnToken: string }) => {
        if (!arrived.includes(input.spawnToken)) {
          arrived.push(input.spawnToken)
          if (arrived.length === 2) {
            releaseBoth()
          }
          await bothArrived
        }
        return {
          hostId: input.hostId,
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: input.spawnToken
        }
      }
    )

    const replayedInput = { ...adoptInput(), threadId: THREAD_ID }
    const superseded = rig.runtime.adoptStructuredAgentSessionTerminal(replayedInput, {
      callerKey: 'renderer-1'
    })
    superseded.catch(() => undefined)
    const replay = rig.runtime.adoptStructuredAgentSessionTerminal(replayedInput, {
      callerKey: 'renderer-1'
    })
    expect(replay).toBe(superseded)
    await vi.waitFor(() => expect(arrived).toHaveLength(1))
    // A fresh operation is independent and supersedes the shared delivery's reservation.
    const winner = rig.runtime.adoptStructuredAgentSessionTerminal(
      { ...adoptInput(), threadId: THREAD_ID },
      { callerKey: 'renderer-1' }
    )

    await expect(winner).resolves.toMatchObject({ ok: true })
    await expect(superseded).rejects.toThrow('could not verify its Codex session')
    await expect(replay).rejects.toThrow('could not verify its Codex session')
    // The loser's cleanup ran against a pane and a reservation that were no longer its own.
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      lease: { runtimeKind: 'tui', claimStatus: 'live', handoffStage: null }
    })
  }, 30_000)

  it('rolls back a process identity when proving the owner fails', async () => {
    vi.spyOn(rig.store, 'proveOwner').mockRejectedValueOnce(new Error('fault after process commit'))

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('fault after process commit')
    expect(rig.store.getRecord(SESSION_ID)?.lease).toMatchObject({
      claimStatus: 'reserved',
      ownerProcess: null,
      processlessAt: expect.any(Number)
    })
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBeNull()

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).resolves.toMatchObject({ ok: true })
  }, 30_000)

  it('preserves a just-proved owner when the next runtime step fails', async () => {
    const settlePtyAttempt =
      agentSessionPtyWriteGate.settlePtyAttempt.bind(agentSessionPtyWriteGate)
    const settle = vi.spyOn(agentSessionPtyWriteGate, 'settlePtyAttempt')
    settle.mockImplementationOnce((ptyId, attemptToken) => {
      const settled = settlePtyAttempt(ptyId, attemptToken)
      expect(settled).toBe(true)
      throw new Error('fault after owner proof')
    })

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('fault after owner proof')
    expect(rig.store.getRecord(SESSION_ID)?.lease.claimStatus).toBe('live')
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
  }, 30_000)

  it('keeps the pane settled when journal attachment fails after owner proof', async () => {
    rig.historyFilePath.mockRejectedValueOnce(new Error('journal attach fault'))
    const input = { ...adoptInput(), threadId: THREAD_ID }

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(input, { callerKey: 'renderer-1' })
    ).rejects.toThrow('journal attach fault')
    expect(rig.store.getRecord(SESSION_ID)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { pid: 4242 }
    })
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    expect(agentSessionPtyWriteGate.admit(PTY_ID)).toMatchObject({
      admitted: true,
      sessionId: SESSION_ID
    })

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(input, { callerKey: 'renderer-1' })
    ).resolves.toMatchObject({ ok: true, replayed: true })
  }, 30_000)

  it('keeps the pane settled when outcome persistence fails', async () => {
    vi.spyOn(rig.store, 'recordOperationOutcome').mockRejectedValueOnce(
      new Error('outcome persistence fault')
    )
    const input = { ...adoptInput(), threadId: THREAD_ID }

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(input, { callerKey: 'renderer-1' })
    ).rejects.toThrow('outcome persistence fault')
    expect(rig.store.getRecord(SESSION_ID)?.lease.claimStatus).toBe('live')
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(input, { callerKey: 'renderer-1' })
    ).resolves.toMatchObject({ ok: true, replayed: true })
  }, 30_000)

  it('retries a transient real-store reservation release without masking the proof error', async () => {
    await rm(join(rig.codexHome, 'sessions'), { recursive: true, force: true })
    const release = vi
      .spyOn(rig.store, 'transitionHandoff')
      .mockRejectedValueOnce(new Error('transient store write fault'))
      .mockRejectedValueOnce(new Error('transient store write fault'))
      .mockRejectedValueOnce(new Error('transient store write fault'))

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('did not prove the expected Codex rollout')
    expect(release).toHaveBeenCalledTimes(3)
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe(SESSION_ID)
    await vi.waitFor(
      () => {
        expect(release).toHaveBeenCalledTimes(4)
        expect(rig.store.getRecord(SESSION_ID)?.lease).toMatchObject({
          claimStatus: 'reserved',
          ownerProcess: null,
          processlessAt: expect.any(Number)
        })
        expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBeNull()
      },
      { timeout: 3_000 }
    )
  }, 30_000)

  it('does not recreate a pane binding when the pane exits during settlement', async () => {
    const settle = vi.spyOn(agentSessionPtyWriteGate, 'settlePtyAttempt')
    settle.mockImplementationOnce((ptyId) => {
      const internal = rig.runtime as unknown as {
        ptysById: Map<string, { connected: boolean }>
      }
      internal.ptysById.get(ptyId)!.connected = false
      agentSessionPtyWriteGate.unbindPty(ptyId)
      return false
    })

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION_ID)?.lease.claimStatus).toBe('live')
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBeNull()
  }, 30_000)

  it('refuses a pane another structured session already owns', async () => {
    agentSessionPtyWriteGate.bindPty(PTY_ID, 'someone-elses-session')

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(
        { ...adoptInput(), threadId: THREAD_ID },
        { callerKey: 'renderer-1' }
      )
    ).rejects.toThrow('already belongs to another structured Codex session')
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBe('someone-elses-session')
    expect(rig.store.getRecord(SESSION_ID)).toBeNull()
  })
})
