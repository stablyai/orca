import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import type { SleepingAgentSessionRecord } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  store
} from '../orca-runtime-test-fixtures.spec'

function makeRecord(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'test',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function startRuntime(opts: {
  window: boolean
  record: SleepingAgentSessionRecord
  ownerHostId?: 'local' | 'ssh:ssh-1'
}): {
  runtime: OrcaRuntimeService
  notifier: { activateWorktree: ReturnType<typeof vi.fn>; resumeSleepingAgents: ReturnType<typeof vi.fn> }
  readHostIds: () => (string | undefined)[]
} {
  const ownerHostId = opts.ownerHostId ?? 'local'
  const repo = { ...store.getRepos()[0]!, executionHostId: ownerHostId }
  // Only the owning host's partition holds the record, so a wrong partition read misses it.
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [opts.record.paneKey]: opts.record }
    },
    ownerHostId
  )
  const getWorkspaceSession = vi.fn((hostId?: string) =>
    hostId === undefined ? getDefaultWorkspaceSession() : runtimeStore.getWorkspaceSession(hostId)
  )
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getRepos: () => [repo],
    getRepo: (id: string) => (id === TEST_REPO_ID ? repo : undefined),
    getWorkspaceSession
  })
  const notifier = {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    resumeSleepingAgents: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every notifier member the runtime calls during attach and wake.
  runtime.setNotifier(notifier as never)
  electronMocks.BrowserWindow.fromId.mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getAvailableAuthoritativeWindow only checks isDestroyed on the found window.
    (opts.window ? { isDestroyed: () => false } : null) as never
  )
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  return {
    runtime,
    notifier,
    readHostIds: () => getWorkspaceSession.mock.calls.map(([hostId]) => hostId)
  }
}

describe('OrcaRuntimeService.wakeManagedWorktree', () => {
  it('queues the wake of slept agents without navigating the desktop', async () => {
    const { runtime, notifier } = startRuntime({ window: true, record: makeRecord() })

    const result = await runtime.wakeManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(result).toEqual({ worktreeId: TEST_WORKTREE_ID, sleepingAgentWake: 'requested' })
    await vi.waitFor(() =>
      expect(notifier.resumeSleepingAgents).toHaveBeenCalledWith(TEST_WORKTREE_ID)
    )
    expect(notifier.activateWorktree).not.toHaveBeenCalled()
  })

  it('reports unsupported-headless for a hibernated agent only a window wakes', async () => {
    const { runtime } = startRuntime({ window: false, record: makeRecord() })

    const result = await runtime.wakeManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(result.sleepingAgentWake).toBe('unsupported-headless')
  })

  // Main resumes a workspace sleep's running agent itself, so a headless host wakes it too.
  it('reports a requested wake headless for a workspace sleep record', async () => {
    const { runtime } = startRuntime({
      window: false,
      record: makeRecord({ origin: 'worktree-sleep', state: 'working' })
    })

    const result = await runtime.wakeManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(result.sleepingAgentWake).toBe('requested')
  })

  it("reads the sleeping records of the worktree's host", async () => {
    const { runtime, readHostIds } = startRuntime({
      window: false,
      record: makeRecord(),
      ownerHostId: 'ssh:ssh-1'
    })

    const result = await runtime.wakeManagedWorktree(`id:${TEST_WORKTREE_ID}`)

    expect(readHostIds()).toContain('ssh:ssh-1')
    expect(result.sleepingAgentWake).toBe('unsupported-headless')
  })
})
