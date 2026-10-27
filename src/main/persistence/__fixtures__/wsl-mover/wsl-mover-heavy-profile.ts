import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WslMoveProjectionInput } from '../../moving-wsl-projects/wsl-move-state-projection'
import {
  project,
  repo,
  tabGroup,
  terminalTab,
  unifiedTab,
  worktreeMeta,
  wslMoverPaths,
  type WslMoverPaths
} from './wsl-mover-profile-rows'

export function heavyWslMoverProfile(paths: WslMoverPaths): WslMoveProjectionInput {
  const sourcePaths = wslMoverPaths('source')
  const repoA = repo('repo-a', paths.at('/home/dev/app'))
  const repoB = repo('repo-b', paths.at('/home/dev/lib', 'wsl$'))
  const wtA = `repo-a::${repoA.path}`
  const wtFeature = `repo-a::${paths.at('/home/dev/app-feature')}`
  const wtB = `repo-b::${repoB.path}`
  // Preserve source UNC IDs as aliases for clients still using them.
  const sourceIds = new Map([
    [wtA, `repo-a::${sourcePaths.at('/home/dev/app')}`],
    [wtFeature, `repo-a::${sourcePaths.at('/home/dev/app-feature')}`],
    [wtB, `repo-b::${sourcePaths.at('/home/dev/lib', 'wsl$')}`]
  ])
  const movedFrom = (worktreeId: string): { priorWorktreeIds?: string[] } => {
    const sourceId = sourceIds.get(worktreeId)
    return paths.side === 'destination' && sourceId ? { priorWorktreeIds: [sourceId] } : {}
  }
  const readme = paths.at('/home/dev/app/README.md')
  const editorId = `editor:${encodeURIComponent(wtA)}:local:${encodeURIComponent(readme)}`
  const session: Partial<WorkspaceSessionState> = {
    activeRepoId: 'repo-a',
    activeWorktreeId: wtA,
    activeTabId: 'tab-1',
    tabsByWorktree: {
      [wtA]: [terminalTab('tab-1', wtA, paths.at('/home/dev/app'), 'pty-1')],
      [wtFeature]: [terminalTab('tab-2', wtFeature, null, 'pty-2')],
      [wtB]: [terminalTab('tab-3', wtB, paths.at('/home/dev/lib/src'), null)]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-1' },
          second: { type: 'leaf', leafId: 'leaf-2' }
        },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-1b' },
        scrollbackRefsByLeafId: { 'leaf-1': 'ref-1', 'leaf-2': 'ref-2' },
        titlesByLeafId: { 'leaf-1': 'build', 'leaf-2': 'claude' }
      },
      'tab-2': { root: null, activeLeafId: null, expandedLeafId: null },
      'tab-3': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    localOnlyScrollbackByTabId: { 'tab-3': { 'leaf-9': 'parked output' } },
    activeWorktreeIdsOnShutdown: [wtA, wtB],
    openFilesByWorktree: {
      [wtA]: [
        {
          filePath: readme,
          relativePath: 'README.md',
          worktreeId: wtA,
          language: 'markdown',
          dirtyDraftContent: '# unsaved draft'
        }
      ]
    },
    activeFileIdByWorktree: { [wtA]: editorId },
    markdownFrontmatterVisible: { [editorId]: true },
    browserTabsByWorktree: {
      [wtA]: [
        {
          id: 'bw-1',
          worktreeId: wtA,
          url: paths.fileUrl('/home/dev/app/docs/index.html'),
          title: 'Docs',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1
        }
      ]
    },
    browserPagesByWorkspace: {
      'bw-1': [
        {
          id: 'page-1',
          workspaceId: 'bw-1',
          worktreeId: wtA,
          url: paths.fileUrl('/home/dev/app/docs/index.html'),
          title: 'Docs',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1,
          docLocation: {
            kind: 'workspace-doc',
            worktreeId: wtA,
            filePath: readme
          }
        }
      ]
    },
    activeBrowserTabIdByWorktree: { [wtA]: 'bw-1' },
    activeTabTypeByWorktree: { [wtA]: 'terminal' },
    workspaceDocHistory: [
      {
        docLocation: {
          kind: 'workspace-doc',
          worktreeId: wtA,
          filePath: readme
        },
        title: 'README',
        lastVisitedAt: 5,
        visitCount: 2
      }
    ],
    activeTabIdByWorktree: { [wtA]: 'tab-1' },
    unifiedTabs: {
      [wtA]: [unifiedTab('tab-1', wtA, 'group-1'), unifiedTab(readme, wtA, 'group-1')]
    },
    tabGroups: { [wtA]: [tabGroup('group-1', wtA, ['tab-1', readme])] },
    tabGroupLayouts: { [wtA]: { type: 'leaf', groupId: 'group-1' } },
    activeGroupIdByWorktree: { [wtA]: 'group-1' },
    remoteSessionIdsByTabId: { 'tab-1': 'session-1' },
    lastVisitedAtByWorktreeId: { [wtA]: 10, [wtB]: 9 },
    defaultTerminalTabsAppliedByWorktreeId: { [wtA]: true },
    sleepingAgentSessionsByPaneKey: {
      'tab-1:leaf-2': {
        paneKey: 'tab-1:leaf-2',
        tabId: 'tab-1',
        worktreeId: wtA,
        agent: 'claude',
        providerSession: { key: 'session_id', id: 'claude-session-1' },
        prompt: 'fix the build',
        state: 'done',
        capturedAt: 3,
        updatedAt: 4
      }
    },
    terminalPtyIncarnationsByPaneKey: { 'tab-1:leaf-1': 'incarnation-1' },
    terminalTopologyRevisionByRepoId: {
      'repo-a': paths.side === 'source' ? 7 : 1
    },
    terminalSurfaceTombstonesByPaneKey: {
      'tab-2:leaf-x': {
        worktreeId: wtFeature,
        parentTabId: 'tab-2',
        leafId: 'leaf-x',
        ptyId: 'pty-old',
        incarnationId: 'incarnation-old',
        retiredAt: 2
      }
    },
    closedTerminalTabTombstonesByTabId: {
      'tab-old': { closedAt: 1, worktreeId: wtB }
    }
  }
  return {
    state: {
      repos: [repoA, repoB],
      projects: [project('project-a', ['repo-a']), project('project-b', ['repo-b'])],
      projectGroups: [],
      folderWorkspaces: [],
      sparsePresetsByRepo: { 'repo-a': [] },
      retiredWorktreeNamesByRepo: {},
      worktreeMeta: {
        [wtA]: { ...worktreeMeta('app'), ...movedFrom(wtA) },
        [wtFeature]: { ...worktreeMeta('feature'), comment: 'WIP', ...movedFrom(wtFeature) },
        [wtB]: { ...worktreeMeta('lib'), ...movedFrom(wtB) }
      },
      worktreeLineageById: {
        [wtFeature]: {
          worktreeId: wtFeature,
          worktreeInstanceId: 'instance-feature',
          parentWorktreeId: wtA,
          parentWorktreeInstanceId: 'instance-app',
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: 2
        }
      },
      workspaceLineageByChildKey: {},
      automations: [],
      automationRuns: []
    },
    session,
    ui: {
      lastActiveWorktreeId: wtA,
      showDotfilesByWorktree: { [wtA]: true },
      explorerDisplayRootByWorktree: { [wtA]: paths.at('/home/dev/app/src') },
      filterRepoIds: ['repo-a'],
      acknowledgedAgentsByPaneKey: { 'tab-1:leaf-2': 4 },
      manualRepoOrder: [{ hostId: 'local', repoId: 'repo-a' }]
    }
  }
}
