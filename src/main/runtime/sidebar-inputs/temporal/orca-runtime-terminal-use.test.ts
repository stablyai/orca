// Runs on plain Node, as orcad does: the host that owns a workspace records its terminal use.
import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-session-contracts'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  WORKSPACE_CLEANUP_IDLE_MS,
  getPersistedWorkspaceCleanupActivityAt,
  isWorkspaceOldForCleanup
} from '../../../../shared/workspace-cleanup/workspace-cleanup'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta,
  type PartialRuntimeStore
} from '../../orca-runtime-tests/runtime-store-partial-fixture'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const WT = 'repo-1::/tmp/phone-only'
const DAY_MS = 24 * 60 * 60 * 1000

function createHeadlessRuntime(ptyId = 'pty-1') {
  // Untouched for 45 days: no agent ran, so no Recent stamp moved.
  const meta: Record<string, WorktreeMeta> = { [WT]: storeWorktreeMeta({ lastActivityAt: 1 }) }
  const repo = storeRepo({ id: 'repo-1', path: '/tmp/repo-1', connectionId: null })
  const store: PartialRuntimeStore = {
    // An unstamped row's writes resolve their host from its repo's only registration.
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getSettings: () => ({}),
    getWorktreeMeta: (id: string) => meta[id],
    getAllWorktreeMeta: () => meta,
    setWorktreeMeta: ({ id }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
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
  return { runtime, meta }
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
})
