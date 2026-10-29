// Runs on plain Node, as orcad does: the host that owns a workspace records its terminal use.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-session-contracts'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  WORKSPACE_CLEANUP_IDLE_MS,
  getPersistedWorkspaceCleanupActivityAt,
  isWorkspaceOldForCleanup
} from '../../../shared/workspace-cleanup'
import { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_USE_THROTTLE_MS } from './terminal-use-producer'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta,
  type PartialRuntimeStore
} from '../runtime-store-partial-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/phone-only'
const DAY_MS = 24 * 60 * 60 * 1000

function createHeadlessRuntime(ptyId = 'pty-1') {
  // Untouched for 45 days: no agent ran, so no Recent stamp moved.
  const meta: Record<string, WorktreeMeta> = { [WT]: storeWorktreeMeta({ lastActivityAt: 1 }) }
  const writes: Partial<WorktreeMeta>[] = []
  const repo = storeRepo({ id: 'repo-1', path: '/tmp/repo-1', connectionId: null })
  const store: PartialRuntimeStore = {
    // An unstamped row's writes resolve their host from its repo's only registration.
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: ({ id }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      writes.push(updates)
      meta[id] = { ...meta[id], ...updates }
      return meta[id]
    }
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  // No desktop window: the phone is the only client.
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, {
    tabs: [{ tabId: 'tab-1', worktreeId: WT, title: 'zsh', activeLeafId: 'pane:1', layout: null }],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WT,
        leafId: 'pane:1',
        paneRuntimeId: 1,
        ptyId,
        paneTitle: null
      }
    ]
  })
  return { runtime, meta, writes }
}

describe('host-written terminal use', () => {
  it('a phone-only workspace whose terminals are closed is not idle to cleanup', () => {
    const now = 45 * DAY_MS
    vi.useFakeTimers({ now })
    try {
      const { runtime, meta } = createHeadlessRuntime()
      // Typing in a plain shell from the phone goes through the host's one input funnel.
      runtime.terminalRunFacts.recordInput('pty-1', 'driving', 'ls\r', now - 2 * DAY_MS)
      runtime.onPtyExit('pty-1', 0)
      expect(meta[WT]?.lastTerminalUseAt).toBe(now - 2 * DAY_MS)
      const workspace = { isArchived: false, lastActivityAt: meta[WT]?.lastActivityAt ?? 0 }
      expect(isWorkspaceOldForCleanup(workspace, now)).toBe(true)
      const lastActive = getPersistedWorkspaceCleanupActivityAt({
        lastActivityAt: workspace.lastActivityAt,
        lastTerminalUseAt: meta[WT]?.lastTerminalUseAt
      })
      expect(isWorkspaceOldForCleanup({ ...workspace, lastActivityAt: lastActive }, now)).toBe(
        false
      )
      expect(now - lastActive).toBeLessThan(WORKSPACE_CLEANUP_IDLE_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes at most once a minute per workspace, and never for terminal replies', () => {
    const { runtime, writes } = createHeadlessRuntime()
    runtime.terminalRunFacts.recordInput('pty-1', 'query-reply', '\x1b[0n', 1_000)
    expect(writes).toEqual([])
    runtime.terminalRunFacts.recordInput('pty-1', 'driving', 'a', 1_000)
    runtime.terminalRunFacts.recordInput(
      'pty-1',
      'driving',
      'b',
      1_000 + TERMINAL_USE_THROTTLE_MS - 1
    )
    runtime.terminalRunFacts.recordInput('pty-1', 'driving', 'c', 1_000 + TERMINAL_USE_THROTTLE_MS)
    expect(writes).toEqual([
      { lastTerminalUseAt: 1_000 },
      { lastTerminalUseAt: 1_000 + TERMINAL_USE_THROTTLE_MS }
    ])
  })

  it('app-written launch input never counts', () => {
    const launch = createHeadlessRuntime()
    launch.runtime.terminalRunFacts.recordInput('pty-1', 'launch', 'claude\r', 1_000)
    expect(launch.writes).toEqual([])
  })

  it("a paired server's terminal is not this host's to record", () => {
    const mirrored = createHeadlessRuntime('remote:server-pty')
    mirrored.runtime.terminalRunFacts.recordInput('remote:server-pty', 'driving', 'ls\r', 1_000)
    expect(mirrored.writes).toEqual([])
  })

  it('output never counts as use', () => {
    const { runtime, writes } = createHeadlessRuntime()
    runtime.onPtyData('pty-1', 'lots of output\r\n', 1)
    expect(writes.filter((w) => 'lastTerminalUseAt' in w)).toEqual([])
  })
})
