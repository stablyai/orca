import { aiVaultResumeMountAdapters } from './ai-vault-resume-mount-adapters'
import {
  agentHistoryMountAdapters,
  agentHistoryMountExposures
} from './agent-history-mount-adapters'
import {
  agentHistoryScreenMountAdapters,
  agentHistoryScreenMountExposures
} from './agent-history-screen-mount-adapters'
import { browserMountAdapters } from './browser-mount-adapters'
import { clientEventStreamMountAdapters } from './client-event-stream-mount-adapters'
import { clipboardImageMountAdapters } from './clipboard-image-mount-adapters'
import { codexResetCreditMountAdapters } from './codex-reset-credit-mount-adapters'
import { dictationMountAdapters } from './dictation-mount-adapters'
import { diffReviewActionMountAdapters } from './diff-review-action-mount-adapters'
import { diffReviewMountAdapters } from './diff-review-mount-adapters'
import {
  fileExplorerScreenMountAdapters,
  fileExplorerScreenMountExposures
} from './file-explorer-screen-mount-adapters'
import { fileInventoryMountAdapters } from './file-inventory-mount-adapters'
import { fileTapOpenMountAdapters } from './file-tap-open-mount-adapters'
import { fileRequestMountAdapters } from './file-request-mount-adapters'
import { githubPrMountAdapters } from './github-pr-mount-adapters'
import { homeAccountsMountAdapters } from './home-accounts-mount-adapters'
import { hostScreenMountAdapters } from './host-screen-mount-adapters'
import { hostWorktreeActionMountAdapters } from './host-worktree-action-mount-adapters'
import { hostedReviewMountAdapters } from './hosted-review-mount-adapters'
import { nativeChatWriteMountAdapters } from './native-chat-write-mount-adapters'
import { newTabAgentMountAdapters } from './new-tab-agent-mount-adapters'
import {
  notificationTestScreenMountAdapters,
  notificationTestScreenMountExposures
} from './notification-test-screen-mount-adapters'
import { newWorkspaceMountAdapters } from './new-workspace-mount-adapters'
import { newWorkspaceRepositoryMountAdapters } from './new-workspace-repository-mount-adapters'
import { pairingJournalMountAdapters } from './pairing-journal-mount-adapters'
import { pushDismissalMountAdapters } from './push-dismissal-mount-adapters'
import {
  pushRegistrationMountAdapters,
  pushRegistrationMountExposures
} from './push-registration-mount-adapters'
import { relayCredentialMountAdapters } from './relay-credential-mount-adapters'
import { sessionNotesMountAdapters } from './session-notes-mount-adapters'
import { sessionScreenReadMountAdapters } from './session-screen-read-mount-adapters'
import { sessionScreenTabMountAdapters } from './session-screen-tab-mount-adapters'
import { sessionTabMountAdapters } from './session-tab-mount-adapters'
import { sessionTerminalInputMountAdapters } from './session-terminal-input-mount-adapters'
import { settingsMountAdapters, settingsMountExposures } from './settings-mount-adapters'
import { sourceControlMountAdapters } from './source-control-mount-adapters'
import { structuredAgentLaunchMountAdapters } from './structured-agent-launch-mount-adapters'
import { taskItemChecksStatusMountAdapters } from './task-item-checks-status-mount-adapters'
import { taskItemConversationMountAdapters } from './task-item-conversation-mount-adapters'
import { taskItemDetailMountAdapters } from './task-item-detail-mount-adapters'
import { taskItemHostedMetadataMountAdapters } from './task-item-hosted-metadata-mount-adapters'
import { taskItemMetadataMountAdapters } from './task-item-metadata-mount-adapters'
import { tasksLinearWorkspaceMountAdapters } from './tasks-linear-workspace-mount-adapters'
import { taskListMountAdapters } from './task-list-mount-adapters'
import { taskMountAdapters } from './task-mount-adapters'
import { taskProjectBoardLoadMountAdapters } from './task-project-board-load-mount-adapters'
import { taskProjectRowCommentMountAdapters } from './task-project-row-comment-mount-adapters'
import { taskProjectRowFieldMountAdapters } from './task-project-row-field-mount-adapters'
import { taskProjectRowMergeMountAdapters } from './task-project-row-merge-mount-adapters'
import { taskProjectRowReadMountAdapters } from './task-project-row-read-mount-adapters'
import {
  tasksRouteScreenMountAdapters,
  tasksRouteScreenMountExposures
} from './tasks-route-screen-mount-adapters'
import { taskWorkspaceHookMountAdapters } from './task-workspace-hook-mount-adapters'
import { taskWorkspaceSenderMountAdapters } from './task-workspace-sender-mount-adapters'
import { terminalMountAdapters } from './terminal-mount-adapters'
import { transportStatusMountAdapters } from './transport-status-mount-adapters'
import { workspaceSettingsMounts } from './workspace-settings-mounts'
import { worktreeCatalogMountAdapters } from './worktree-catalog-mount-adapters'
import type { MountedOperationModule } from '../mounted-operation-module'

/**
 * Every domain's mount adapters, paired with the file each one lives in. The register lives inside
 * the seam it registers, so adding a domain edits no engine file and moves no existing golden;
 * `adapter-seam.test.ts` checks each pairing names the file that declares it.
 */
export const MOUNTED_OPERATION_MODULES: readonly MountedOperationModule[] = [
  {
    source: 'agent-history-mount-adapters.ts',
    mounts: agentHistoryMountAdapters,
    exposes: agentHistoryMountExposures
  },
  {
    source: 'agent-history-screen-mount-adapters.ts',
    mounts: agentHistoryScreenMountAdapters,
    exposes: agentHistoryScreenMountExposures
  },
  { source: 'ai-vault-resume-mount-adapters.ts', mounts: aiVaultResumeMountAdapters },
  { source: 'browser-mount-adapters.ts', mounts: browserMountAdapters },
  { source: 'client-event-stream-mount-adapters.ts', mounts: clientEventStreamMountAdapters },
  { source: 'clipboard-image-mount-adapters.ts', mounts: clipboardImageMountAdapters },
  { source: 'codex-reset-credit-mount-adapters.ts', mounts: codexResetCreditMountAdapters },
  { source: 'dictation-mount-adapters.ts', mounts: dictationMountAdapters },
  { source: 'diff-review-action-mount-adapters.ts', mounts: diffReviewActionMountAdapters },
  { source: 'diff-review-mount-adapters.ts', mounts: diffReviewMountAdapters },
  {
    source: 'file-explorer-screen-mount-adapters.ts',
    mounts: fileExplorerScreenMountAdapters,
    exposes: fileExplorerScreenMountExposures
  },
  { source: 'file-inventory-mount-adapters.ts', mounts: fileInventoryMountAdapters },
  { source: 'file-tap-open-mount-adapters.ts', mounts: fileTapOpenMountAdapters },
  { source: 'file-request-mount-adapters.ts', mounts: fileRequestMountAdapters },
  { source: 'github-pr-mount-adapters.ts', mounts: githubPrMountAdapters },
  { source: 'home-accounts-mount-adapters.ts', mounts: homeAccountsMountAdapters },
  { source: 'host-screen-mount-adapters.ts', mounts: hostScreenMountAdapters },
  {
    source: 'host-worktree-action-mount-adapters.ts',
    mounts: hostWorktreeActionMountAdapters
  },
  { source: 'hosted-review-mount-adapters.ts', mounts: hostedReviewMountAdapters },
  { source: 'native-chat-write-mount-adapters.ts', mounts: nativeChatWriteMountAdapters },
  { source: 'new-tab-agent-mount-adapters.ts', mounts: newTabAgentMountAdapters },
  { source: 'new-workspace-mount-adapters.ts', mounts: newWorkspaceMountAdapters },
  {
    source: 'new-workspace-repository-mount-adapters.ts',
    mounts: newWorkspaceRepositoryMountAdapters
  },
  {
    source: 'notification-test-screen-mount-adapters.ts',
    mounts: notificationTestScreenMountAdapters,
    exposes: notificationTestScreenMountExposures
  },
  { source: 'pairing-journal-mount-adapters.ts', mounts: pairingJournalMountAdapters },
  { source: 'push-dismissal-mount-adapters.ts', mounts: pushDismissalMountAdapters },
  {
    source: 'push-registration-mount-adapters.ts',
    mounts: pushRegistrationMountAdapters,
    exposes: pushRegistrationMountExposures
  },
  { source: 'relay-credential-mount-adapters.ts', mounts: relayCredentialMountAdapters },
  { source: 'session-notes-mount-adapters.ts', mounts: sessionNotesMountAdapters },
  {
    source: 'session-screen-read-mount-adapters.ts',
    mounts: sessionScreenReadMountAdapters
  },
  { source: 'session-screen-tab-mount-adapters.ts', mounts: sessionScreenTabMountAdapters },
  { source: 'session-tab-mount-adapters.ts', mounts: sessionTabMountAdapters },
  {
    source: 'session-terminal-input-mount-adapters.ts',
    mounts: sessionTerminalInputMountAdapters
  },
  {
    source: 'settings-mount-adapters.ts',
    mounts: settingsMountAdapters,
    exposes: settingsMountExposures
  },
  { source: 'source-control-mount-adapters.ts', mounts: sourceControlMountAdapters },
  {
    source: 'structured-agent-launch-mount-adapters.ts',
    mounts: structuredAgentLaunchMountAdapters
  },
  {
    source: 'task-item-checks-status-mount-adapters.ts',
    mounts: taskItemChecksStatusMountAdapters
  },
  { source: 'task-item-conversation-mount-adapters.ts', mounts: taskItemConversationMountAdapters },
  { source: 'task-item-detail-mount-adapters.ts', mounts: taskItemDetailMountAdapters },
  {
    source: 'task-item-hosted-metadata-mount-adapters.ts',
    mounts: taskItemHostedMetadataMountAdapters
  },
  { source: 'task-item-metadata-mount-adapters.ts', mounts: taskItemMetadataMountAdapters },
  { source: 'task-list-mount-adapters.ts', mounts: taskListMountAdapters },
  {
    source: 'tasks-linear-workspace-mount-adapters.ts',
    mounts: tasksLinearWorkspaceMountAdapters
  },
  { source: 'task-mount-adapters.ts', mounts: taskMountAdapters },
  {
    source: 'task-project-board-load-mount-adapters.ts',
    mounts: taskProjectBoardLoadMountAdapters
  },
  {
    source: 'task-project-row-comment-mount-adapters.ts',
    mounts: taskProjectRowCommentMountAdapters
  },
  { source: 'task-project-row-field-mount-adapters.ts', mounts: taskProjectRowFieldMountAdapters },
  { source: 'task-project-row-merge-mount-adapters.ts', mounts: taskProjectRowMergeMountAdapters },
  { source: 'task-project-row-read-mount-adapters.ts', mounts: taskProjectRowReadMountAdapters },
  {
    source: 'tasks-route-screen-mount-adapters.ts',
    mounts: tasksRouteScreenMountAdapters,
    exposes: tasksRouteScreenMountExposures
  },
  { source: 'task-workspace-hook-mount-adapters.ts', mounts: taskWorkspaceHookMountAdapters },
  { source: 'task-workspace-sender-mount-adapters.ts', mounts: taskWorkspaceSenderMountAdapters },
  { source: 'terminal-mount-adapters.ts', mounts: terminalMountAdapters },
  { source: 'transport-status-mount-adapters.ts', mounts: transportStatusMountAdapters },
  { source: 'workspace-settings-mounts.ts', mounts: workspaceSettingsMounts },
  { source: 'worktree-catalog-mount-adapters.ts', mounts: worktreeCatalogMountAdapters }
]
