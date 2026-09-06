import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { killAllProcessesForWorktree } = await import('./worktree-teardown')
const { listLiveStructuredSessionsForWorktree } =
  await import('./structured-session-worktree-teardown')

const WORKTREE = 'repo_1::/tmp/wt-a'
const OTHER_WORKTREE = 'repo_1::/tmp/wt-b'

function record(sessionId: string, workspaceId: string): AgentSessionRecord {
  return {
    sessionId,
    provider: 'claude',
    location: { executionHostId: 'local', wslDistro: null, workspaceId, workspaceKind: 'folder' },
    lease: {
      sessionId,
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 1,
      deathEvidence: null
    }
  } as unknown as AgentSessionRecord
}

function installHost(options: {
  records: AgentSessionRecord[]
  /** Sessions the host still holds; a close removes one unless it is listed as stuck. */
  stuck?: Set<string>
}): { closed: string[] } {
  const held = new Set(options.records.map((entry) => entry.sessionId))
  const closed: string[] = []
  hostRef.current = {
    deps: { store: { listRecords: () => options.records, getRecord: () => null } },
    hasSession: (sessionId: string) => held.has(sessionId),
    setSessionTabVisibility: async () => {},
    close: async (sessionId: string) => {
      closed.push(sessionId)
      if (!options.stuck?.has(sessionId)) {
        held.delete(sessionId)
      }
    }
  }
  // `observeStructuredWorker` reads the record through the same host, so keep them consistent.
  ;(
    hostRef.current as { deps: { store: { getRecord: (id: string) => unknown } } }
  ).deps.store.getRecord = (sessionId: string) =>
    options.records.find((entry) => entry.sessionId === sessionId) ?? null
  return { closed }
}

const localProvider = {
  listProcesses: async () => [],
  shutdown: async () => {}
} as never

function destructiveDeps(extra: { allowUnverifiedStop?: boolean } = {}) {
  return {
    localProvider,
    requirePhysicalStop: true,
    includeProviderInventory: false as const,
    includeLocalRegistry: false as const,
    ...extra
  }
}

describe('worktree teardown and structured agent sessions', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('finds sessions by workspace, and ignores a sibling worktree', () => {
    installHost({ records: [record('s1', WORKTREE), record('s2', OTHER_WORKTREE)] })
    expect(listLiveStructuredSessionsForWorktree(WORKTREE)).toEqual([
      { sessionId: 's1', agent: 'claude' }
    ])
  })

  it('refuses a destructive removal rather than deleting the checkout under a live child', async () => {
    // The defect this pins: all three PTY sweeps enumerate leaves, provider sessions and the local
    // registry, and a structured session is on NONE of them. Every sweep answered zero, nothing
    // errored, and removal proceeded — leaving the provider child running with its `cwd` deleted
    // and the dispatch still reporting the worker live and exact.
    installHost({ records: [record('s1', WORKTREE)] })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(
      /1 running agent session/
    )
  })

  it('names the force escape hatch in the refusal, like the unstopped-PTY gate', async () => {
    installHost({ records: [record('s1', WORKTREE)] })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(/force/i)
  })

  it('closes them under force instead of orphaning the child', async () => {
    const host = installHost({ records: [record('s1', WORKTREE), record('s2', WORKTREE)] })
    const result = await killAllProcessesForWorktree(
      WORKTREE,
      destructiveDeps({ allowUnverifiedStop: true })
    )
    expect(host.closed).toEqual(['s1', 's2'])
    expect(result.structuredStopped).toBe(2)
  })

  it('still removes under force when a close does not settle, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const result = await killAllProcessesForWorktree(
      WORKTREE,
      destructiveDeps({ allowUnverifiedStop: true })
    )
    expect(result.structuredStopped).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still attached'))
    warn.mockRestore()
  })

  it('leaves the best-effort reconciliation paths alone', async () => {
    // Those callers repair state and delete nothing, so a refusal there would wedge a repair.
    installHost({ records: [record('s1', WORKTREE)] })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false
      })
    ).resolves.toMatchObject({ runtimeStopped: 0 })
  })

  it('does not block removal when no structured host is installed', async () => {
    // Not being able to look is not evidence a child is there, and reading the persisted store
    // directly would force-install the host as a side effect of a teardown.
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      runtimeStopped: 0
    })
  })
})
