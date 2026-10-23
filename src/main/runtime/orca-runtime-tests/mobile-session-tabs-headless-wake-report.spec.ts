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

function makeRecord(origin: SleepingAgentSessionRecord['origin']): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: 'test',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...(origin ? { origin } : {})
  }
}

async function activateOnHeadlessServe(
  record: SleepingAgentSessionRecord,
  ownerHostId: 'local' | 'ssh:ssh-1' = 'local'
): Promise<{ wake: string | undefined; readHostIds: (string | undefined)[] }> {
  const repo = { ...store.getRepos()[0]!, executionHostId: ownerHostId }
  // Only the owning host's partition holds the record, so a wrong partition read misses it.
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    },
    ownerHostId
  )
  // The fixture also answers a host-less read; this check must name the host, so that read is empty.
  const getWorkspaceSession = vi.fn((hostId?: string) =>
    hostId === undefined ? getDefaultWorkspaceSession() : runtimeStore.getWorkspaceSession(hostId)
  )
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getRepos: () => [repo],
    getRepo: (id: string) => (id === TEST_REPO_ID ? repo : undefined),
    getWorkspaceSession
  })
  // Headless: no BrowserWindow backs the authoritative id.
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  const result = await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
    notifyClients: false,
    clientKind: 'mobile'
  })
  return {
    wake: result.sleepingAgentWake,
    readHostIds: getWorkspaceSession.mock.calls.map(([hostId]) => hostId)
  }
}

describe('OrcaRuntimeService headless wake report', () => {
  // Why: 'live'/'quit' records describe running or quit agents, not slept ones; reporting them
  // as unwakeable showed the phone a false "wake sleeping agents" warning.
  it.each(['live', 'quit'] as const)(
    'reports no headless wake degradation for a worktree with only a %s record',
    async (origin) => {
      const { wake } = await activateOnHeadlessServe(makeRecord(origin))
      expect(wake).toBe('not-applicable')
    }
  )

  it('reports headless wake degradation for a legacy sleep record only a window wakes', async () => {
    const { wake } = await activateOnHeadlessServe(makeRecord(undefined))
    expect(wake).toBe('unsupported-headless')
  })

  // Main resumes a workspace sleep's running agent itself, so a headless host wakes it too.
  it('reports a requested wake for a workspace sleep record, which main resumes', async () => {
    const { wake } = await activateOnHeadlessServe(makeRecord('worktree-sleep'))
    expect(wake).toBe('requested')
  })

  it('reads the sleep record from an SSH-host worktree partition', async () => {
    const { wake, readHostIds } = await activateOnHeadlessServe(makeRecord(undefined), 'ssh:ssh-1')
    expect(readHostIds).toContain('ssh:ssh-1')
    expect(wake).toBe('unsupported-headless')
  })

  it('ignores a live record on an SSH-host worktree partition', async () => {
    const { wake } = await activateOnHeadlessServe(makeRecord('live'), 'ssh:ssh-1')
    expect(wake).toBe('not-applicable')
  })
})
