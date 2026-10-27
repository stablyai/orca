import type { Automation, AutomationRun } from '../../../../shared/automations-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WslMoveProjectionInput } from '../../moving-wsl-projects/wsl-move-state-projection'
import {
  project,
  repo,
  terminalTab,
  worktreeMeta,
  type WslMoverPaths
} from './wsl-mover-profile-rows'

export function foldersAndAutomationsWslMoverProfile(paths: WslMoverPaths): WslMoveProjectionInput {
  const repoAuto = repo('repo-auto', paths.at('/srv/jobs'))
  const wtAuto = `repo-auto::${repoAuto.path}`
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'Ops',
    parentPath: paths.at('/srv'),
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const folder: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Notes',
    folderPath: paths.at('/srv/notes'),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const runContext = {
    kind: 'workspace-run' as const,
    projectId: 'project-auto',
    hostId: 'local' as const,
    projectHostSetupId: paths.side === 'source' ? 'setup-local' : 'setup-wsl',
    repoId: 'repo-auto',
    path: repoAuto.path
  }
  const automation: Automation = {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'Run the nightly sweep',
    precheck: null,
    agentId: 'claude',
    runContext,
    projectId: 'repo-auto',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: paths.side === 'source' ? 'local_host_service' : 'remote_host_service',
    workspaceMode: 'existing',
    workspaceId: wtAuto,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 1,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    enabled: true,
    nextRunAt: 2,
    createdAt: 1,
    updatedAt: 1
  }
  const run: AutomationRun = {
    id: 'run-1',
    automationId: 'auto-1',
    runContext,
    title: 'Nightly #1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: wtAuto,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1
  }
  const lineage: WorkspaceLineage = {
    childWorkspaceKey: worktreeWorkspaceKey(wtAuto),
    parentWorkspaceKey: folderWorkspaceKey('folder-1'),
    origin: 'manual',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  }
  return {
    state: {
      repos: [{ ...repoAuto, projectGroupId: 'group-1' }],
      projects: [project('project-auto', ['repo-auto'])],
      projectGroups: [group],
      folderWorkspaces: [folder],
      sparsePresetsByRepo: {},
      retiredWorktreeNamesByRepo: {},
      worktreeMeta: { [wtAuto]: worktreeMeta('jobs') },
      worktreeLineageById: {},
      workspaceLineageByChildKey: { [lineage.childWorkspaceKey]: lineage },
      automations: [automation],
      automationRuns: [run]
    },
    session: {
      tabsByWorktree: {
        'folder:folder-1': [terminalTab('tab-f', 'folder:folder-1', null, null)]
      },
      lastVisitedAtByWorktreeId: { 'folder:folder-1': 3 }
    }
  }
}
