import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { killAllProcessesForWorktree } = await import('./worktree-teardown')
const { classifyWorktreeForceDeleteReason } = await import('../../shared/worktree/removal')
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
        const record = options.records.find((entry) => entry.sessionId === sessionId)
        if (record) {
          record.lease.claimStatus = 'released'
          record.lease.deathEvidence = { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
        }
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

  it('classifies for the desktop Force Delete button, not just the CLI', async () => {
    // The #11960 dead end, and the shape this file's own comments warn about: the desktop
    // affordance comes ONLY from the classifier, and an ordinary delete already passes force:true
    // for the dirty-file skip — so a refusal with no matcher shows raw CLI wording with no button.
    installHost({ records: [record('s1', WORKTREE)] })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(classifyWorktreeForceDeleteReason(error as string, true)).toBe('running-agent-session')
    // Nulled once the waiver is spent, exactly as `unstopped-pty` is, so the button does not
    // reappear on a delete the user already forced.
    expect(classifyWorktreeForceDeleteReason(error as string, true, true)).toBeNull()
  })

  it('keeps session ids out of a message users and agents read', async () => {
    // A session id is one tab-id hop from the random pane key that gates a worker's mailbox, and
    // this string reaches CLI output and a desktop toast. A count and the providers are what a
    // user deciding whether to force actually needs.
    installHost({ records: [record('s1', WORKTREE)] })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).not.toContain('s1')
    expect(error).toContain('1 running agent session')
  })

  it('closes best-effort for a folder-workspace removal, which requires no stop proof', async () => {
    // Those paths sweep and kill PTYs without `requirePhysicalStop`, so the structured sweep used
    // to no-op there and left a live session bound to a workspace Orca was about to forget. They
    // do not refuse: the root is shared so no checkout vanishes, and one of them is a never-throw
    // forget that a refusal would wedge.
    const host = installHost({ records: [record('s1', WORKTREE)] })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false,
        closeStructuredSessions: true
      })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    expect(host.closed).toEqual(['s1'])
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
