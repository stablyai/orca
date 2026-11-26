import { useAppStore } from '../store'
import { useClosedEditorTabCleanup } from '../components/editor/model-lifetime/retention/useClosedEditorTabCleanup'
import { useIpcEvents } from '../hooks/useIpcEvents'
import { useReadOnScreenAttention } from '../attention/useReadOnScreenAttention'
import { useAppMenuPaste } from '../hooks/clipboard/menu/useAppMenuPaste'
import { useAppMenuSelectionActions } from '../hooks/app-commands/useAppMenuSelectionActions'
import { useLargeTextControlPaste } from '../hooks/text-input/paste/useLargeTextControlPaste'
import {
  resolvePrimarySelectionMiddleClickPaste,
  usePrimarySelectionPaste
} from '../hooks/clipboard/primary-selection/usePrimarySelectionPaste'
import { useRadixBodyPointerEventsRecovery } from './useRadixBodyPointerEventsRecovery'
import { useOsc52ClipboardDefaultOnNotice } from '../components/terminal-pane/clipboard/osc52-clipboard-default-on-notice'
import { useWindowsTerminalFontWeightNotice } from '../components/terminal-pane/appearance/windows-terminal-font-weight-notice'
import { useLocalStructuredSessionTabsSync } from '../runtime/local-structured-session-tabs-sync/use-local-structured-session-tabs-sync'
import { useHostStructuredAgentsSync } from '../runtime/native-chat/agent-catalogs/host-structured-agents-sync'
import { useLegacyChatRenameMigration } from '../runtime/native-chat/naming/legacy-chat-rename-migration'
import { useHostModelCatalogSnapshotsSync } from '../runtime/native-chat/model-catalogs/host-model-catalog-snapshots-sync'
import { useRemoteRuntimeRecoveryTriggers } from '../runtime/hosts/connections/use-remote-runtime-recovery-triggers'
import { useTerminalViewerColorPublication } from '../components/terminal-pane/appearance/use-terminal-viewer-color-publication'
import { useBrowserIdentityMigrationNotice } from '../components/settings/browser/browser-user-agent-migration-notice'
import { useBrowserClientHostedDownloadNotices } from '../components/browser-pane/navigate/browser-client-hosted-download-notices'
import { useCodexTerminalServerIsolationNotice } from '../components/terminal-pane/provider-notices/codex-server-isolation/codex-terminal-server-isolation-notice'
import { useClaudeThemeSyncOffer } from '../components/terminal-pane/provider-notices/claude-theme-sync/claude-theme-sync-offer'
import { usePerfNotices } from '../components/perf-notices/use-perf-notices'
import { useVisibleHostedReviewRefresh } from '../store/slices/hosted-review/refresh/use-visible-hosted-review-refresh'
import { useProfileStateSaveDelayNotice } from './storage/use-profile-state-save-delay-notice'
import { useBotHomeTabPlacement } from '../components/bots/bot-home-tab-placement'
import { useUnsavedEditorHostReport } from '../runtime/workspace-cleanup/unsaved-editor-host-report'

/** Keep subscriptions above surfaces that unmount or never appear on Landing. */
export function useAppShellServices(): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const primarySelectionMiddleClickPaste = useAppStore((s) =>
    resolvePrimarySelectionMiddleClickPaste(s.settings?.primarySelectionMiddleClickPaste)
  )

  useClosedEditorTabCleanup()
  useRadixBodyPointerEventsRecovery()
  useLocalStructuredSessionTabsSync()
  useBotHomeTabPlacement()
  useHostStructuredAgentsSync()
  useLegacyChatRenameMigration()
  useHostModelCatalogSnapshotsSync()
  useIpcEvents()
  useProfileStateSaveDelayNotice()
  useRemoteRuntimeRecoveryTriggers()
  useUnsavedEditorHostReport()
  useVisibleHostedReviewRefresh({ enabled: workspaceSessionReady })
  useTerminalViewerColorPublication()
  useReadOnScreenAttention()
  useAppMenuPaste()
  useAppMenuSelectionActions()
  useLargeTextControlPaste()
  usePrimarySelectionPaste(primarySelectionMiddleClickPaste)
  useOsc52ClipboardDefaultOnNotice(persistedUIReady)
  useWindowsTerminalFontWeightNotice(persistedUIReady)
  useBrowserIdentityMigrationNotice()
  useBrowserClientHostedDownloadNotices()
  useCodexTerminalServerIsolationNotice()
  useClaudeThemeSyncOffer()
  usePerfNotices()
}
