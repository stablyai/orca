import { useAppStore } from '../store'
import { useIpcEvents } from '../hooks/useIpcEvents'
import { useAutomationDispatchEvents } from '../hooks/useAutomationDispatchEvents'
import { useAutoAckViewedAgent } from '../hooks/useAutoAckViewedAgent'
import { useEditorExternalWatch } from '../hooks/useEditorExternalWatch'
import { useGlobalFileDrop } from '../hooks/useGlobalFileDrop'
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
import { useWebSessionTabsSync } from '../runtime/web-session-tabs-sync'
import { useRemoteRuntimeRecoveryTriggers } from '../runtime/use-remote-runtime-recovery-triggers'

/**
 * App-level subscriptions that must outlive any individual surface. Each one is here because
 * the component that consumes its result unmounts (right sidebar, explorer, terminal) or is
 * absent entirely on the landing path.
 */
export function useAppShellServices(options: { floatingPanelVisible: boolean }): void {
  const workspaceSessionReady = useAppStore((s) => s.workspaceSessionReady)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const primarySelectionMiddleClickPaste = useAppStore((s) =>
    resolvePrimarySelectionMiddleClickPaste(s.settings?.primarySelectionMiddleClickPaste)
  )

  useRadixBodyPointerEventsRecovery()
  useWebSessionTabsSync()
  // Subscribe to IPC push events
  useIpcEvents()
  useRemoteRuntimeRecoveryTriggers()
  useAutomationDispatchEvents()
  // Why: git polling lives at App level (RightSidebar unmounts when closed, stranding stale Rebasing/Merging badges); gate on workspaceSessionReady so it doesn't compete with first paint.
  useGitStatusPolling({ enabled: workspaceSessionReady })
  // Why: wire file-change watching at App level so the editor keeps hearing FS changes when Explorer unmounts (right-sidebar switches to Source Control/Checks).
  useEditorExternalWatch()
  useGlobalFileDrop()
  useAutoAckViewedAgent(options.floatingPanelVisible)
  useAppMenuPaste()
  useAppMenuSelectionActions()
  useLargeTextControlPaste()
  usePrimarySelectionPaste(primarySelectionMiddleClickPaste)
  useOsc52ClipboardDefaultOnNotice(persistedUIReady)
}
