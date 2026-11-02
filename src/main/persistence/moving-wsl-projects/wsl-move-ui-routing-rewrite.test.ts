import { describe, expect, it } from 'vitest'

import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceCleanupDismissal } from '../../../shared/workspace-cleanup'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoverProfile } from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { wslMoveRewriteScope } from './wsl-move-rewrite-scope'
import { rewriteWslMoveUiRouting, type WslMoveUiRoutingState } from './wsl-move-ui-routing-rewrite'

const HOST = toRuntimeExecutionHostId('wsl:Ubuntu')
const scope = wslMoveRewriteScope({
  cutover: wslMoveCutoverFixture('move-1', 'destination-committed', {}, { repoIds: ['repo-a'] }),
  rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
  destinationHostId: HOST,
  recordSeededHostWorkspaceIds: () => {}
})

// The mixed profile: repo-a moves; repo-b (same distro), repo-win and repo-deb stay.
const source = wslMoverProfile('mixed-windows-wsl', 'source')
const destination = wslMoverProfile('mixed-windows-wsl', 'destination')
const sourceRepo = (id: string): string =>
  source.state.repos.find((repo) => repo.id === id)?.path ?? ''
const MOVED = `repo-a::${sourceRepo('repo-a')}`
const MOVED_ON_HOST = 'repo-a::/home/dev/app'
const SAME_DISTRO = `repo-b::${sourceRepo('repo-b')}`
const WINDOWS = `repo-win::${sourceRepo('repo-win')}`
const SSH = 'ssh:box' as const
const sourceUi = source.ui ?? {}
const destinationUi = destination.ui ?? {}
const EMPTY_UI: WslMoveUiRoutingState = { lastActiveWorktreeId: null, collapsedGroups: [] }

function profileUi(): WslMoveUiRoutingState {
  const ui = sourceUi
  return {
    lastActiveWorktreeId: ui.lastActiveWorktreeId ?? null,
    showDotfilesByWorktree: {
      ...ui.showDotfilesByWorktree,
      [SAME_DISTRO]: false
    },
    explorerDisplayRootByWorktree: {
      ...ui.explorerDisplayRootByWorktree,
      [WINDOWS]: 'C:\\src\\win\\lib'
    },
    workspaceCleanup: {
      dismissals: {
        [`local\0${MOVED}`]: dismissal(MOVED, 'local'),
        [`${SSH}\0${MOVED}`]: dismissal(MOVED, SSH),
        [SAME_DISTRO]: dismissal(SAME_DISTRO)
      }
    },
    manualRepoOrder: [
      { hostId: 'local', repoId: 'repo-win' },
      ...(ui.manualRepoOrder ?? []),
      { hostId: 'local', repoId: 'repo-b' },
      { hostId: SSH, repoId: 'repo-a' }
    ],
    workspaceHostScope: 'local',
    visibleWorkspaceHostIds: null,
    agentsVisibleHostIds: [SSH, 'local'],
    workspaceHostOrder: ['local', SSH],
    setupScriptPromptDismissedRepoIds: [
      'generation-v1:local\0repo-a',
      'generation-v1:local\0repo-b',
      `generation-v1:${SSH}\0repo-a`
    ],
    collapsedGroups: [
      `lineage:local|${MOVED}`,
      `lineage:${SSH}|${MOVED}`,
      `lineage:local|${SAME_DISTRO}`,
      'repo:repo-a'
    ]
  }
}

function dismissal(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): WorkspaceCleanupDismissal {
  return {
    worktreeId,
    dismissedAt: 1,
    fingerprint: 'f',
    classifierVersion: 1,
    ...(executionHostId ? { executionHostId } : {})
  }
}

describe('WSL move UI routing rewrite', () => {
  it("copies only the moved project's rows to the host's form, keeping the local ones", () => {
    const ui = profileUi()
    const updates = rewriteWslMoveUiRouting(ui, scope)

    expect(updates.lastActiveWorktreeId).toBe(destinationUi.lastActiveWorktreeId)
    expect(updates.showDotfilesByWorktree).toEqual({
      ...ui.showDotfilesByWorktree,
      ...destinationUi.showDotfilesByWorktree
    })
    expect(updates.explorerDisplayRootByWorktree).toEqual({
      ...ui.explorerDisplayRootByWorktree,
      ...destinationUi.explorerDisplayRootByWorktree
    })
    expect(updates.workspaceCleanup?.dismissals).toEqual({
      ...ui.workspaceCleanup?.dismissals,
      [`${HOST}\0${MOVED_ON_HOST}`]: dismissal(MOVED_ON_HOST, HOST)
    })
    expect(updates.manualRepoOrder).toEqual([
      { hostId: 'local', repoId: 'repo-win' },
      { hostId: 'local', repoId: 'repo-a' },
      { hostId: HOST, repoId: 'repo-a' },
      { hostId: 'local', repoId: 'repo-b' },
      { hostId: SSH, repoId: 'repo-a' }
    ])
  })

  it('copies a legacy bare dismissal key, and one with no host, in their own form', () => {
    const updates = rewriteWslMoveUiRouting(
      { ...EMPTY_UI, workspaceCleanup: { dismissals: { [MOVED]: dismissal(MOVED) } } },
      scope
    )

    expect(updates.workspaceCleanup?.dismissals).toEqual({
      [MOVED]: dismissal(MOVED),
      [MOVED_ON_HOST]: dismissal(MOVED_ON_HOST)
    })
  })

  it("maps an in-scope folder workspace's explorer root in place, its key unchanged", () => {
    const folderScope = wslMoveRewriteScope({
      cutover: wslMoveCutoverFixture(
        'move-1',
        'destination-committed',
        {},
        { repoIds: [], folderWorkspaceIds: ['folder-1'] }
      ),
      rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
      destinationHostId: HOST,
      recordSeededHostWorkspaceIds: () => {}
    })
    const other = '\\\\wsl.localhost\\Ubuntu\\srv\\other'
    const updates = rewriteWslMoveUiRouting(
      {
        ...EMPTY_UI,
        explorerDisplayRootByWorktree: {
          'folder:folder-1': '\\\\wsl.localhost\\Ubuntu\\srv\\notes\\src',
          'folder:folder-2': other
        }
      },
      folderScope
    )

    expect(updates.explorerDisplayRootByWorktree).toEqual({
      'folder:folder-1': '/srv/notes/src',
      'folder:folder-2': other
    })
  })

  it('reads the older wsl$ spelling and a lowercase distro as the moved distro', () => {
    const bothScope = wslMoveRewriteScope({
      cutover: wslMoveCutoverFixture(
        'move-1',
        'destination-committed',
        {},
        { repoIds: ['repo-a', 'repo-b'] }
      ),
      rewritePath: createUncToLinuxPathRewriter('Ubuntu'),
      destinationHostId: HOST,
      recordSeededHostWorkspaceIds: () => {}
    })
    const lowercase = 'repo-a::\\\\wsl.localhost\\ubuntu\\home\\dev\\app'
    const updates = rewriteWslMoveUiRouting(
      // SAME_DISTRO is spelled `\\wsl$\Ubuntu\...` by the fixture.
      { ...EMPTY_UI, showDotfilesByWorktree: { [SAME_DISTRO]: true, [lowercase]: false } },
      bothScope
    )

    expect(SAME_DISTRO).toContain('wsl$')
    expect(updates.showDotfilesByWorktree).toEqual({
      [SAME_DISTRO]: true,
      [lowercase]: false,
      'repo-b::/home/dev/lib': true,
      [MOVED_ON_HOST]: false
    })
  })

  it('changes nothing on a second run', () => {
    const first = {
      ...profileUi(),
      ...rewriteWslMoveUiRouting(profileUi(), scope)
    }

    expect(rewriteWslMoveUiRouting(first, scope)).toEqual({})
  })
})
