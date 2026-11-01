// A phone on a host with no window may show something other than main only where it then shows
// what the desktop window does; the window's side is pinned in headless-phone-window-parity.test.ts.

import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  HEADLESS_PHONE_LAYOUT_CASES,
  HEADLESS_PHONE_WORKTREES,
  type PhoneLayoutView
} from '../../../shared/workspace-layout/headless-phone-layout.test-fixture'
import { leaf } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { deriveHeadlessLegacyTerminalLeafId } from '../mobile-session-layout-projection'
import { OrcaRuntimeService } from '../orca-runtime'

const repos = [
  { id: 'repo-1', path: '/repos', displayName: 'repo-1', badgeColor: 'blue', addedAt: 1 }
]

function hydratedRuntime(session: WorkspaceSessionState) {
  const runtime = new OrcaRuntimeService({
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    addRepo: () => {},
    updateRepo: () => {
      throw new Error('unused')
    },
    setWorktreeMeta: () => {
      throw new Error('unused')
    },
    removeWorktreeMeta: () => {},
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
    addRetiredWorktreeName: () => {},
    mergeRetiredWorktreeNames: () => false,
    getSettings: () => getDefaultSettings('/tmp/home'),
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {}
  })
  runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(undefined, { force: true })
  return runtime
}

function phoneView(session: WorkspaceSessionState): PhoneLayoutView {
  const view: PhoneLayoutView = {}
  for (const [worktreeId, snapshot] of hydratedRuntime(session).mobileSessionTabsByWorktree) {
    view[worktreeId] = {
      panes: snapshot.tabs.flatMap((tab) =>
        tab.type === 'terminal' ? [`${tab.parentTabId} ${tab.ptyId ?? '-'} ${tab.title}`] : []
      ),
      active: snapshot.activeTabId?.split('::')[0] ?? null,
      groups: (snapshot.tabGroups ?? []).map((group) => ({
        tabs: group.tabOrder,
        active: group.activeTabId
      }))
    }
  }
  return view
}

describe('headless phone terminal tabs', () => {
  it.each(HEADLESS_PHONE_LAYOUT_CASES)('$name', (scenario) => {
    for (const worktreeId of scenario.phoneFollowsDesktop) {
      expect(scenario.desktop[worktreeId]).not.toEqual(scenario.main[worktreeId])
    }
    const expected = Object.fromEntries(
      Object.entries(scenario.main).map(([worktreeId, view]) => [
        worktreeId,
        scenario.phoneFollowsDesktop.includes(worktreeId) ? scenario.desktop[worktreeId] : view
      ])
    )
    expect(phoneView(scenario.build())).toEqual(expected)
  })

  it('keeps pane ids in worktrees with no absorbed row', () => {
    const scenario = HEADLESS_PHONE_LAYOUT_CASES.find((entry) =>
      entry.name.startsWith('duplicate in one worktree')
    )!
    const { B, C, D } = HEADLESS_PHONE_WORKTREES
    const leafIds = (worktreeId: string) =>
      hydratedRuntime(scenario.build())
        .mobileSessionTabsByWorktree.get(worktreeId)
        ?.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.leafId] : []))
    expect(leafIds(B)).toEqual([leaf(4), leaf(5)])
    expect(leafIds(C)).toEqual([leaf(6)])
    expect(leafIds(D)).toEqual([deriveHeadlessLegacyTerminalLeafId('tab-old')])
  })
})
