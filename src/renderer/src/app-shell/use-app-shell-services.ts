import { useAppStore } from '../store'
import { useClosedEditorTabCleanup } from '../components/editor/useClosedEditorTabCleanup'
import { useIpcEvents } from '../hooks/useIpcEvents'
import { useAutomationDispatchEvents } from '../hooks/useAutomationDispatchEvents'
import { useReadOnScreenAttention } from '../hooks/useReadOnScreenAttention'
import { useEditorExternalWatch } from '../hooks/useEditorExternalWatch'
import { useAppMenuPaste } from '../hooks/useAppMenuPaste'
import { useAppMenuSelectionActions } from '../hooks/useAppMenuSelectionActions'
import { useLargeTextControlPaste } from '../hooks/useLargeTextControlPaste'
import {
  resolvePrimarySelectionMiddleClickPaste,
  usePrimarySelectionPaste
} from '../hooks/usePrimarySelectionPaste'
import { useRadixBodyPointerEventsRecovery } from '../hooks/useRadixBodyPointerEventsRecovery'
import { useGitStatusPolling } from '../components/right-sidebar/useGitStatusPolling'
import { useOsc52ClipboardDefaultOnNotice } from '../components/terminal-pane/osc52-clipboard-default-on-notice'
import { useWebSessionTabsSync } from '../runtime/web-session-tabs-sync/use-web-session-tabs-sync'
import { useLocalStructuredSessionTabsSync } from '../runtime/local-structured-session-tabs-sync'
import { useHostStructuredAgentsSync } from '../runtime/host-structured-agents-sync'
import { useLegacyChatRenameMigration } from '../runtime/legacy-chat-rename-migration'
import { useHostModelCatalogSnapshotsSync } from '../runtime/host-model-catalog-snapshots-sync'
import { useRemoteRuntimeRecoveryTriggers } from '../runtime/use-remote-runtime-recovery-triggers'
import { useTerminalViewerColorPublication } from './use-terminal-viewer-color-publication'
import { useBrowserIdentityMigrationNotice } from '../components/browser-pane/browser-user-agent-migration-notice'
import { useBrowserClientHostedDownloadNotices } from '../components/browser-pane/browser-client-hosted-download-notices'
import { useCodexTerminalServerIsolationNotice } from '../components/terminal-pane/codex-terminal-server-isolation-notice'
import { useCodexSharedSettingsNotice } from '../components/terminal-pane/codex-shared-settings-notice'
import { useVisibleReviewRefreshReporting } from './use-visible-review-refresh-reporting'
import { useVisibleHostedReviewRefresh } from './use-visible-hosted-review-refresh'
import { useProfileStateSaveDelayNotice } from './use-profile-state-save-delay-notice'

/** Keep subscriptions above surfaces that unmount or never appear on Landing. */
export function useAppShellServices(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const primarySelectionMiddleClickPaste = useAppStore((s) =>
    resolvePrimarySelectionMiddleClickPaste(s.settings?.primarySelectionMiddleClickPaste)
  )

  useClosedEditorTabCleanup()
  useRadixBodyPointerEventsRecovery()
  useWebSessionTabsSync()
  useLocalStructuredSessionTabsSync()
  useHostStructuredAgentsSync()
  useLegacyChatRenameMigration()
  useHostModelCatalogSnapshotsSync()
  useIpcEvents()
  useProfileStateSaveDelayNotice()
  useRemoteRuntimeRecoveryTriggers()
  useVisibleReviewRefreshReporting()
  useVisibleHostedReviewRefresh({ enabled: workspaceSessionReady })
  useTerminalViewerColorPublication()
  useAutomationDispatchEvents()
  // Poll above the removable sidebar to keep rebase/merge badges fresh; wait for session readiness to protect first paint.
  useGitStatusPolling({ enabled: workspaceSessionReady })
  // Watch files above Explorer so editor changes still arrive on Source Control/Checks.
  useEditorExternalWatch()
  useReadOnScreenAttention()
  useAppMenuPaste()
  useAppMenuSelectionActions()
  useLargeTextControlPaste()
  usePrimarySelectionPaste(primarySelectionMiddleClickPaste)
  useOsc52ClipboardDefaultOnNotice(persistedUIReady)
  useBrowserIdentityMigrationNotice()
  useBrowserClientHostedDownloadNotices()
  useCodexTerminalServerIsolationNotice()
  useCodexSharedSettingsNotice()
}
