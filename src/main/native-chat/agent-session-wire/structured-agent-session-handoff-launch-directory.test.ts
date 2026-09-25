import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  AgentSessionWorkspaceMissingError,
  resolveAgentSessionLaunchDirectory
} from '../../runtime/agent-session-launch-directory'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { createStructuredHandoffFlowContext } from './structured-agent-session-handoff-flow-context'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const journals = createTrackedJournalOpener()

const NOW = 1_800_000_000_000
const SESSION = 'session-floating-handoff'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'

const FLOATING: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
  workspaceKind: 'folder'
}
const WORKTREE: AgentSessionExecutionLocation = {
  ...FLOATING,
  workspaceId: 'repo-1::/repos/one',
  workspaceKind: 'git-worktree'
}

let root: string
let store: AgentSessionRecordStore
let journal: Awaited<ReturnType<typeof openAgentSessionJournal>>
let operations: number

function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

function processIdentity(spawnToken: string, pid: number) {
  return { hostId: 'local', pid, processStartTimeMs: NOW - 1_000, spawnToken }
}

function link(fence: number, id: string) {
  return {
    linkId: id,
    handle: { provider: 'codex' as const, threadId: THREAD },
    origin: 'resumed' as const,
    mintedAtFence: fence,
    observedAt: NOW
  }
}

function tuiOwner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'tab-tui:leaf-tui', ptyId: 'pty' },
    process: processIdentity(spawnToken, 4200),
    link: link(fence, `tui-link-${fence}`)
  }
}

async function establishNativeOwner(
  location: AgentSessionExecutionLocation,
  workspacePath?: string
): Promise<void> {
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'native-initial',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(), fingerprint: 'initial' },
    now: NOW,
    ...(workspacePath ? { workspacePath } : {})
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: processIdentity('native-initial', 4100),
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: { ...link(fence, 'initial-link'), origin: 'created' },
    now: NOW
  })
}

function request(): AgentSessionHandoffRequest {
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: 'test-handoff'
    },
    direction: 'to-tui',
    mode: 'now'
  }
}

/** Composes the directory rule exactly as the structured-session runtime installs it. */
function handoff(currentSetting: string) {
  const launchTui = vi.fn<StructuredAgentSessionHandoffTransport['launchTui']>(
    async ({ fence, spawnToken }) => tuiOwner(fence, spawnToken)
  )
  const suspendNative = vi.fn(async () => ({ state: 'stopped' as const }))
  const resolveWorkspacePath = vi.fn(async (workspaceId: string) =>
    workspaceId === FLOATING_TERMINAL_WORKTREE_ID ? currentSetting : `/resolved/${workspaceId}`
  )
  const deps: StructuredAgentSessionHandoffDeps = {
    store,
    claimKeyId: 'key-1',
    transport: {
      hostLabel: 'Test host',
      launchTui,
      reproveTuiOwner: async ({ owner }) => owner,
      recoverTuiOwner: async (record) => tuiOwner(record.lease.runtimeFence, 'recovered'),
      stopRecoveredOwner: async () => undefined,
      waitForTuiExit: async () => ({}),
      waitForTuiIdleOrExit: async () => 'idle',
      tuiStatus: () => 'idle',
      stopFailedTuiLaunch: async () => undefined
    },
    resolveLaunchDirectory: (record) =>
      resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record),
    session: () => ({ journal, fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }),
    suspendNative,
    acquireNative: vi.fn(async () => {
      throw new Error('native acquisition should not run')
    }),
    importTuiHistory: vi.fn(async () => undefined),
    retryPendingSettlement: vi.fn(async () => true),
    publish: () => undefined,
    schedule: async (_sessionId, task) => task(),
    now: () => NOW
  }
  const context = createStructuredHandoffFlowContext({
    deps,
    owner: () => undefined,
    retainOwner: vi.fn(),
    releaseOwner: vi.fn(),
    setStatus: () => undefined,
    requireRecord: (sessionId): AgentSessionRecord => {
      const record = store.getRecord(sessionId)
      if (!record) {
        throw new Error('missing record')
      }
      return record
    }
  })
  return { context, launchTui, suspendNative, resolveWorkspacePath }
}

async function directory(name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-handoff-directory-'))
  operations = 0
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
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

describe('structured handoff launch directory', () => {
  it('opens a floating chat terminal in its pinned folder after the floating setting changed', async () => {
    const pinned = await directory('floating-original')
    const changed = await directory('floating-changed')
    await establishNativeOwner(FLOATING, pinned)
    const { context, launchTui, resolveWorkspacePath } = handoff(changed)

    await handoffStructuredSessionToTui(context, request(), false)

    expect(launchTui).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cwd: pinned }))
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({ runtimeKind: 'tui' })
  })

  it('refuses a floating handoff whose pinned folder is gone, leaving the chat live', async () => {
    const gone = join(root, 'deleted-floating')
    const changed = await directory('floating-changed')
    await establishNativeOwner(FLOATING, gone)
    const before = store.getRecord(SESSION)?.lease
    const { context, launchTui, suspendNative, resolveWorkspacePath } = handoff(changed)

    await expect(handoffStructuredSessionToTui(context, request(), false)).rejects.toBeInstanceOf(
      AgentSessionWorkspaceMissingError
    )

    expect(launchTui).not.toHaveBeenCalled()
    expect(suspendNative).not.toHaveBeenCalled()
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toEqual(before)
  })

  it('opens a worktree chat terminal where its workspace id resolves', async () => {
    await establishNativeOwner(WORKTREE, '/where/it/first/ran')
    const { context, launchTui } = handoff('/unused')

    await handoffStructuredSessionToTui(context, request(), false)

    expect(launchTui).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: `/resolved/${WORKTREE.workspaceId}` })
    )
  })
})
