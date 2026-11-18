import { aiVaultResumeMountAdapters } from './agents/ai-vault-resume-mount-adapters'
import {
  agentHistoryMountAdapters,
  agentHistoryMountExposures
} from './agents/agent-history-mount-adapters'
import {
  agentHistoryScreenMountAdapters,
  agentHistoryScreenMountExposures
} from './agents/agent-history-screen-mount-adapters'
import { browserMountAdapters } from './device-capabilities/browser-mount-adapters'
import { clientEventStreamMountAdapters } from './connectivity/client-event-stream-mount-adapters'
import { clipboardImageMountAdapters } from './device-capabilities/clipboard-image-mount-adapters'
import { codexResetCreditMountAdapters } from './workspaces-settings/codex-reset-credit-mount-adapters'
import { desktopNotificationStreamMountAdapters } from './device-capabilities/desktop-notification-stream-mount-adapters'
import { dictationMountAdapters } from './device-capabilities/dictation-mount-adapters'
import { diffReviewActionMountAdapters } from './source-control/diff-review-action-mount-adapters'
import { diffReviewMountAdapters } from './source-control/diff-review-mount-adapters'
import {
  fileExplorerScreenMountAdapters,
  fileExplorerScreenMountExposures
} from './files/file-explorer-screen-mount-adapters'
import { fileInventoryMountAdapters } from './files/file-inventory-mount-adapters'
import { fileTapOpenMountAdapters } from './files/file-tap-open-mount-adapters'
import { fileRequestMountAdapters } from './files/file-request-mount-adapters'
import { githubPrMountAdapters } from './source-control/github-pr-mount-adapters'
import { hostScreenMountAdapters } from './connectivity/host-screen-mount-adapters'
import { hostWorktreeActionMountAdapters } from './workspaces-settings/host-worktree-action-mount-adapters'
import { hostedReviewMountAdapters } from './source-control/hosted-review-mount-adapters'
import { mobileWebBundleMountAdapters } from './connectivity/mobile-web-bundle-mount-adapters'
import { nativeChatPagingMountAdapters } from './agents/native-chat-paging-mount-adapters'
import { nativeChatWriteMountAdapters } from './agents/native-chat-write-mount-adapters'
import { newTabAgentMountAdapters } from './agents/new-tab-agent-mount-adapters'
import {
  notificationTestScreenMountAdapters,
  notificationTestScreenMountExposures
} from './device-capabilities/notification-test-screen-mount-adapters'
import { newWorkspaceMountAdapters } from './workspaces-settings/new-workspace-mount-adapters'
import { newWorkspaceRepositoryMountAdapters } from './workspaces-settings/new-workspace-repository-mount-adapters'
import { pairingJournalMountAdapters } from './connectivity/pairing-journal-mount-adapters'
import { prSidebarMountAdapters } from './source-control/pr-sidebar-mount-adapters'
import { relayCredentialMountAdapters } from './connectivity/relay-credential-mount-adapters'
import { sessionNotesMountAdapters } from './sessions/session-notes-mount-adapters'
import { sessionScreenReadMountAdapters } from './sessions/session-screen-read-mount-adapters'
import { sessionScreenTabMountAdapters } from './sessions/session-screen-tab-mount-adapters'
import { sessionStartupMountAdapters } from './sessions/session-startup-mount-adapters'
import { sessionTabMountAdapters } from './sessions/session-tab-mount-adapters'
import { sessionTerminalCreateMountAdapters } from './sessions/session-terminal-create-mount-adapters'
import { sessionTerminalDisplayModeMountAdapters } from './sessions/session-terminal-display-mode-mount-adapters'
import { sessionTerminalGestureMountAdapters } from './sessions/session-terminal-gesture-mount-adapters'
import { sessionTerminalInputMountAdapters } from './sessions/session-terminal-input-mount-adapters'
import {
  settingsMountAdapters,
  settingsMountExposures
} from './workspaces-settings/settings-mount-adapters'
import { sourceControlMountAdapters } from './source-control/source-control-mount-adapters'
import {
  sourceControlScreenReadMountAdapters,
  sourceControlScreenReadMountExposures
} from './source-control/source-control-screen-read-mount-adapters'
import { structuredAgentLaunchMountAdapters } from './agents/structured-agent-launch-mount-adapters'
import { taskItemChecksStatusMountAdapters } from './tasks/task-item-checks-status-mount-adapters'
import { taskItemConversationMountAdapters } from './tasks/task-item-conversation-mount-adapters'
import { taskItemDetailMountAdapters } from './tasks/task-item-detail-mount-adapters'
import { taskItemHostedMetadataMountAdapters } from './tasks/task-item-hosted-metadata-mount-adapters'
import { taskItemMetadataMountAdapters } from './tasks/task-item-metadata-mount-adapters'
import { tasksLinearWorkspaceMountAdapters } from './tasks/tasks-linear-workspace-mount-adapters'
import { taskListMountAdapters } from './tasks/task-list-mount-adapters'
import { taskMountAdapters } from './tasks/task-mount-adapters'
import { taskProjectBoardLoadMountAdapters } from './tasks/task-project-board-load-mount-adapters'
import { taskProjectRowCommentMountAdapters } from './tasks/task-project-row-comment-mount-adapters'
import { taskProjectRowFieldMountAdapters } from './tasks/task-project-row-field-mount-adapters'
import { taskProjectRowMergeMountAdapters } from './tasks/task-project-row-merge-mount-adapters'
import { taskProjectRowReadMountAdapters } from './tasks/task-project-row-read-mount-adapters'
import {
  tasksRouteScreenMountAdapters,
  tasksRouteScreenMountExposures
} from './tasks/tasks-route-screen-mount-adapters'
import { taskWorkspaceHookMountAdapters } from './tasks/task-workspace-hook-mount-adapters'
import { taskWorkspaceSenderMountAdapters } from './tasks/task-workspace-sender-mount-adapters'
import { terminalMountAdapters } from './sessions/terminal-mount-adapters'
import { transportStatusMountAdapters } from './connectivity/transport-status-mount-adapters'
import { workspaceSettingsMounts } from './workspaces-settings/workspace-settings-mounts'
import { worktreeCatalogMountAdapters } from './workspaces-settings/worktree-catalog-mount-adapters'
import type { MountedOperationModule } from '../module-mounting/mounted-operation-module'

/** Keep domain registration inside its seam to avoid engine edits or golden moves. */
export const MOUNTED_OPERATION_MODULES: readonly MountedOperationModule[] = [
  {
    source: 'agents/agent-history-mount-adapters.ts',
    mounts: agentHistoryMountAdapters,
    exposes: agentHistoryMountExposures
  },
  {
    source: 'agents/agent-history-screen-mount-adapters.ts',
    mounts: agentHistoryScreenMountAdapters,
    exposes: agentHistoryScreenMountExposures
  },
  { source: 'agents/ai-vault-resume-mount-adapters.ts', mounts: aiVaultResumeMountAdapters },
  { source: 'device-capabilities/browser-mount-adapters.ts', mounts: browserMountAdapters },
  {
    source: 'connectivity/client-event-stream-mount-adapters.ts',
    mounts: clientEventStreamMountAdapters
  },
  {
    source: 'device-capabilities/clipboard-image-mount-adapters.ts',
    mounts: clipboardImageMountAdapters
  },
  {
    source: 'workspaces-settings/codex-reset-credit-mount-adapters.ts',
    mounts: codexResetCreditMountAdapters
  },
  {
    source: 'device-capabilities/desktop-notification-stream-mount-adapters.ts',
    mounts: desktopNotificationStreamMountAdapters
  },
  { source: 'device-capabilities/dictation-mount-adapters.ts', mounts: dictationMountAdapters },
  {
    source: 'source-control/diff-review-action-mount-adapters.ts',
    mounts: diffReviewActionMountAdapters
  },
  { source: 'source-control/diff-review-mount-adapters.ts', mounts: diffReviewMountAdapters },
  {
    source: 'files/file-explorer-screen-mount-adapters.ts',
    mounts: fileExplorerScreenMountAdapters,
    exposes: fileExplorerScreenMountExposures
  },
  { source: 'files/file-inventory-mount-adapters.ts', mounts: fileInventoryMountAdapters },
  { source: 'files/file-tap-open-mount-adapters.ts', mounts: fileTapOpenMountAdapters },
  { source: 'files/file-request-mount-adapters.ts', mounts: fileRequestMountAdapters },
  { source: 'source-control/github-pr-mount-adapters.ts', mounts: githubPrMountAdapters },
  { source: 'connectivity/host-screen-mount-adapters.ts', mounts: hostScreenMountAdapters },
  {
    source: 'workspaces-settings/host-worktree-action-mount-adapters.ts',
    mounts: hostWorktreeActionMountAdapters
  },
  { source: 'source-control/hosted-review-mount-adapters.ts', mounts: hostedReviewMountAdapters },
  {
    source: 'connectivity/mobile-web-bundle-mount-adapters.ts',
    mounts: mobileWebBundleMountAdapters
  },
  { source: 'agents/native-chat-paging-mount-adapters.ts', mounts: nativeChatPagingMountAdapters },
  { source: 'agents/native-chat-write-mount-adapters.ts', mounts: nativeChatWriteMountAdapters },
  { source: 'agents/new-tab-agent-mount-adapters.ts', mounts: newTabAgentMountAdapters },
  {
    source: 'workspaces-settings/new-workspace-mount-adapters.ts',
    mounts: newWorkspaceMountAdapters
  },
  {
    source: 'workspaces-settings/new-workspace-repository-mount-adapters.ts',
    mounts: newWorkspaceRepositoryMountAdapters
  },
  {
    source: 'device-capabilities/notification-test-screen-mount-adapters.ts',
    mounts: notificationTestScreenMountAdapters,
    exposes: notificationTestScreenMountExposures
  },
  { source: 'connectivity/pairing-journal-mount-adapters.ts', mounts: pairingJournalMountAdapters },
  { source: 'source-control/pr-sidebar-mount-adapters.ts', mounts: prSidebarMountAdapters },
  {
    source: 'connectivity/relay-credential-mount-adapters.ts',
    mounts: relayCredentialMountAdapters
  },
  { source: 'sessions/session-notes-mount-adapters.ts', mounts: sessionNotesMountAdapters },
  {
    source: 'sessions/session-screen-read-mount-adapters.ts',
    mounts: sessionScreenReadMountAdapters
  },
  {
    source: 'sessions/session-screen-tab-mount-adapters.ts',
    mounts: sessionScreenTabMountAdapters
  },
  { source: 'sessions/session-startup-mount-adapters.ts', mounts: sessionStartupMountAdapters },
  { source: 'sessions/session-tab-mount-adapters.ts', mounts: sessionTabMountAdapters },
  {
    source: 'sessions/session-terminal-create-mount-adapters.ts',
    mounts: sessionTerminalCreateMountAdapters
  },
  {
    source: 'sessions/session-terminal-display-mode-mount-adapters.ts',
    mounts: sessionTerminalDisplayModeMountAdapters
  },
  {
    source: 'sessions/session-terminal-gesture-mount-adapters.ts',
    mounts: sessionTerminalGestureMountAdapters
  },
  {
    source: 'sessions/session-terminal-input-mount-adapters.ts',
    mounts: sessionTerminalInputMountAdapters
  },
  {
    source: 'workspaces-settings/settings-mount-adapters.ts',
    mounts: settingsMountAdapters,
    exposes: settingsMountExposures
  },
  { source: 'source-control/source-control-mount-adapters.ts', mounts: sourceControlMountAdapters },
  {
    source: 'source-control/source-control-screen-read-mount-adapters.ts',
    mounts: sourceControlScreenReadMountAdapters,
    exposes: sourceControlScreenReadMountExposures
  },
  {
    source: 'agents/structured-agent-launch-mount-adapters.ts',
    mounts: structuredAgentLaunchMountAdapters
  },
  {
    source: 'tasks/task-item-checks-status-mount-adapters.ts',
    mounts: taskItemChecksStatusMountAdapters
  },
  {
    source: 'tasks/task-item-conversation-mount-adapters.ts',
    mounts: taskItemConversationMountAdapters
  },
  { source: 'tasks/task-item-detail-mount-adapters.ts', mounts: taskItemDetailMountAdapters },
  {
    source: 'tasks/task-item-hosted-metadata-mount-adapters.ts',
    mounts: taskItemHostedMetadataMountAdapters
  },
  { source: 'tasks/task-item-metadata-mount-adapters.ts', mounts: taskItemMetadataMountAdapters },
  { source: 'tasks/task-list-mount-adapters.ts', mounts: taskListMountAdapters },
  {
    source: 'tasks/tasks-linear-workspace-mount-adapters.ts',
    mounts: tasksLinearWorkspaceMountAdapters
  },
  { source: 'tasks/task-mount-adapters.ts', mounts: taskMountAdapters },
  {
    source: 'tasks/task-project-board-load-mount-adapters.ts',
    mounts: taskProjectBoardLoadMountAdapters
  },
  {
    source: 'tasks/task-project-row-comment-mount-adapters.ts',
    mounts: taskProjectRowCommentMountAdapters
  },
  {
    source: 'tasks/task-project-row-field-mount-adapters.ts',
    mounts: taskProjectRowFieldMountAdapters
  },
  {
    source: 'tasks/task-project-row-merge-mount-adapters.ts',
    mounts: taskProjectRowMergeMountAdapters
  },
  {
    source: 'tasks/task-project-row-read-mount-adapters.ts',
    mounts: taskProjectRowReadMountAdapters
  },
  {
    source: 'tasks/tasks-route-screen-mount-adapters.ts',
    mounts: tasksRouteScreenMountAdapters,
    exposes: tasksRouteScreenMountExposures
  },
  { source: 'tasks/task-workspace-hook-mount-adapters.ts', mounts: taskWorkspaceHookMountAdapters },
  {
    source: 'tasks/task-workspace-sender-mount-adapters.ts',
    mounts: taskWorkspaceSenderMountAdapters
  },
  { source: 'sessions/terminal-mount-adapters.ts', mounts: terminalMountAdapters },
  {
    source: 'connectivity/transport-status-mount-adapters.ts',
    mounts: transportStatusMountAdapters
  },
  { source: 'workspaces-settings/workspace-settings-mounts.ts', mounts: workspaceSettingsMounts },
  {
    source: 'workspaces-settings/worktree-catalog-mount-adapters.ts',
    mounts: worktreeCatalogMountAdapters
  }
]
