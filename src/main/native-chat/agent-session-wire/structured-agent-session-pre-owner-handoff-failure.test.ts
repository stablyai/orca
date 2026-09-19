import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import {
  findConflictingStructuredAdoption,
  structuredAdoptionConflictError
} from '../structured-agent-session-history-adoption'
import { listStructuredProviderSessionOwnership } from './structured-provider-session-ownership'
import type { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { createStructuredHandoffFlowContext } from './structured-agent-session-handoff-flow-context'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'
import { structuredManualRecoveryIsAdmissible } from './structured-agent-session-manual-recovery'
import { idleStructuredHandoffStatus } from './structured-agent-session-handoff-status'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'

const { readStructuredTuiProcessIdentity, proveCodexTuiRollout, resolvePinnedCodexRolloutProof } =
  vi.hoisted(() => ({
    readStructuredTuiProcessIdentity: vi.fn(),
    proveCodexTuiRollout: vi.fn(),
    resolvePinnedCodexRolloutProof: vi.fn()
  }))

vi.mock('../../runtime/structured-tui-process-identity', () => ({
  readStructuredTuiProcessIdentity
}))
vi.mock('../../codex/codex-tui-rollout-proof', () => ({
  proveCodexTuiRollout,
  resolvePinnedCodexRolloutProof
}))

const journals = createTrackedJournalOpener()

const NOW = 1_800_000_000_000
const SESSION = 'session-strand'
const WORKSPACE = 'repo-1::/tmp/structured-strand'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

let root: string
let store: AgentSessionRecordStore
let journal: Awaited<ReturnType<typeof openAgentSessionJournal>>
let statuses: AgentSessionHandoffStatus[]
let operations: number

function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

function ownerProcess(spawnToken: string, pid: number) {
  return { hostId: 'local', pid, processStartTimeMs: NOW - 1_000, spawnToken }
}

function link(fence: number, id: string, origin: 'adopted' | 'resumed' = 'resumed') {
  return {
    linkId: id,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin,
    mintedAtFence: fence,
    observedAt: NOW
  }
}

/** The proven native owner an external conversation lands in after structured adoption. */
async function establishAdoptedNativeOwner(): Promise<void> {
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'native-initial',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(), fingerprint: 'initial' },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: ownerProcess('native-initial', 4100),
    now: NOW
  })
  await store.proveOwner({ sessionId: SESSION, fence, link: link(fence, 'adopted-link', 'adopted'), now: NOW })
}

function notifier() {
  return {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(async () => ({ tabId: 'tab-renderer' })),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

/** The real launch transport, driven onto the daemon-race shape: a spawn reply with no pid. */
function createPidlessLaunchTransport(args: {
  ptyExitProvable: boolean
}): StructuredAgentSessionHandoffTransport {
  const runtime = new OrcaRuntimeService(
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    { getAgentStatusSnapshot: () => [] }
  )
  runtime.setNotifier(notifier() as never)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-structured' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  const internal = runtime as unknown as Record<string, unknown>
  internal.resolveTerminalWorkspaceLaunchScope = vi.fn(async () => ({
    id: WORKSPACE,
    path: '/tmp/structured-strand',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }))
  internal.markLocalWorkspaceTrustedForAgent = vi.fn()
  internal.waitForTerminal = vi.fn(async () => ({}))
  internal.waitForAdoptedStructuredTuiProof = vi.fn(async () => ({}))
  internal.closeTerminal = vi.fn(async () => undefined)
  internal.waitForStructuredTuiOwnerExit = vi.fn(async () => undefined)
  internal.waitForStructuredTuiPtyExit = vi.fn(
    args.ptyExitProvable
      ? async () => undefined
      : async () => {
          throw new Error('the PTY could not be proven gone')
        }
  )
  return (
    runtime as unknown as {
      createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport
    }
  ).createStructuredAgentSessionHandoffTransport()
}

function createContext(transport: StructuredAgentSessionHandoffTransport) {
  return createStructuredHandoffFlowContext({
    deps: {
      store,
      claimKeyId: 'key-1',
      transport,
      session: () => ({ journal, fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }),
      suspendNative: vi.fn(async () => ({ state: 'stopped' as const })),
      acquireNative: async (input: { sessionId: string; fence: number; spawnToken: string }) => {
        await store.commitProcessIdentity({
          sessionId: input.sessionId,
          fence: input.fence,
          process: ownerProcess(input.spawnToken, 4300),
          now: NOW
        })
        return store.proveOwner({
          sessionId: input.sessionId,
          fence: input.fence,
          link: link(input.fence, `native-link-${input.fence}`),
          now: NOW
        })
      },
      acquireNativeStop: async () => true,
      importTuiHistory: vi.fn(async () => undefined),
      retryPendingSettlement: vi.fn(async () => true),
      prepareTuiHistoryCatchup: vi.fn(async () => undefined),
      recoverTuiHistoryCatchup: vi.fn(async () => undefined),
      activateTuiHistoryCatchup: vi.fn(async () => undefined),
      stopTuiHistoryCatchup: vi.fn(),
      publish: (_sessionId: string, status: AgentSessionHandoffStatus) => statuses.push(status),
      schedule: async (_sessionId: string, task: () => Promise<unknown>) => task(),
      now: () => NOW
    } as never,
    owner: () => undefined,
    retainOwner: vi.fn(),
    releaseOwner: vi.fn(),
    setStatus: (_sessionId: string, status: AgentSessionHandoffStatus) => statuses.push(status),
    requireRecord: (sessionId: string) => {
      const record = store.getRecord(sessionId)
      if (!record) {
        throw new Error('missing record')
      }
      return record
    }
  })
}

/** What a fresh adoption of the same provider conversation would hit today. */
function adoptionConflictCode(): string | null {
  const conflict = findConflictingStructuredAdoption({
    agent: 'codex',
    providerSessionId: THREAD,
    selfSessionId: 'some-other-session',
    ownership: listStructuredProviderSessionOwnership(store.listRecords())
  })
  return conflict ? structuredAdoptionConflictError(conflict).message : null
}

async function runHandoff(transport: StructuredAgentSessionHandoffTransport): Promise<unknown> {
  const context = createContext(transport)
  const operation = operationId()
  return await handoffStructuredSessionToTui(
    context,
    {
      envelope: {
        sessionId: SESSION,
        clientOperationId: operation,
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
        payloadFingerprint: 'test-handoff'
      },
      direction: 'to-tui',
      mode: 'now'
    },
    false
  ).then(
    () => null,
    (error: unknown) => error
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-strand-'))
  operations = 0
  statuses = []
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  await establishAdoptedNativeOwner()
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: join(root, 'journal')
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

// A to-tui launch that fails before any owner process exists must not be able to latch the
// session in `manual-recovery`: that stage is ownerless AND unattributable, `recover` refuses it
// without an owner process, and the only ownerless probe (a spawn-token environment scan) can
// answer on Linux alone. On every other host the record - and with it the adopted provider
// conversation - is stranded for good.
describe('to-tui handoff that fails before an owner process exists', () => {
  it('returns the adopted session to its proven native owner', async () => {
    const error = await runHandoff(createPidlessLaunchTransport({ ptyExitProvable: true }))

    expect((error as Error).message).toContain('did not publish a process identity')
    const record = store.getRecord(SESSION)!
    expect(record.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
    expect(record.lease.ownerProcess).not.toBeNull()
    expect(agentSessionLeaseAdmitsWriter(record.lease)).toBe(true)
    // The same provider conversation is ownable again rather than permanently unknown.
    expect(adoptionConflictCode()).not.toBe('agent_session_ownership_unknown')
    // The provider-native identity is unchanged: no replacement conversation was minted.
    expect(record.providerHandleChain.at(-1)?.handle).toMatchObject({
      provider: 'codex',
      threadId: THREAD
    })
  })

  it('still strands nothing but stays fail-closed when the failed PTY cannot be proven gone', async () => {
    const error = await runHandoff(createPidlessLaunchTransport({ ptyExitProvable: false }))

    expect(error).toBeInstanceOf(Error)
    const record = store.getRecord(SESSION)!
    // Ambiguous ownership: a PTY that will not die may still hold a live provider writer.
    expect(record.lease).toMatchObject({
      handoffStage: 'manual-recovery',
      ownerProcess: null
    })
    expect(agentSessionLeaseAdmitsWriter(record.lease)).toBe(false)
    expect(
      structuredManualRecoveryIsAdmissible(record, idleStructuredHandoffStatus(record))
    ).toBe(false)
    expect(adoptionConflictCode()).toBe('agent_session_ownership_unknown')
  })
})
