import { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from './components/confirmation-dialog'
import { BrowserWebAuthnAccountDialog } from './components/browser-webauthn-account-dialog'
import { BrowserPagePrompts } from './components/browser-pane/browser-page-prompts'
import { LinkRoutingPreferenceDialogProvider } from './components/link-routing-preference-dialog'
import { SkillFreshnessNudge } from './components/skills/SkillFreshnessNudge'
import PinnedTabCloseDialog from './components/terminal-pane/PinnedTabCloseDialog'
import RunningTerminalCloseDialog from './components/terminal-pane/RunningTerminalCloseDialog'
import WorktreeBaseFallbackDialog from './components/WorktreeBaseFallbackDialog'
import ClaudeAccountSwitchDialog from './components/ClaudeAccountSwitchDialog'
import { useUnreadDockBadge } from './hooks/useUnreadDockBadge'
import { AppBackgroundServices } from './app-shell/AppBackgroundServices'
import { AppRootSurfaces } from './app-shell/AppRootSurfaces'
import { AppWorkspaceShell } from './app-shell/AppWorkspaceShell'
import { WindowControls } from './app-shell/WindowControls'
import {
  MAC_TRAFFIC_LIGHTS_WIDTH,
  WINDOW_CONTROLS_HEIGHT,
  WINDOW_CONTROLS_WIDTH,
  hasCustomTitleBar
} from './app-shell/app-window-chrome'
import { useAppChromeLayout } from './app-shell/use-app-chrome-layout'
import { useAppSessionPersistence } from './app-shell/use-app-session-persistence'
import { useAppShellServices } from './app-shell/use-app-shell-services'
import { useAppStartupHydration } from './app-shell/use-app-startup-hydration'
import { startNativeChatDraftLoad } from './app-shell/native-chat-draft-startup'
import { useDocumentAppearance } from './app-shell/use-document-appearance'
import { useFloatingWorkspacePanel } from './app-shell/use-floating-workspace-panel'
import { useGlobalKeybindings } from './app-shell/use-global-keybindings'
import { useOnboardingAndFeatureTips } from './app-shell/use-onboarding-and-feature-tips'
import { usePersistedUIWriter } from './app-shell/use-persisted-ui-writer'
import { useRuntimeGraphSync } from './app-shell/use-runtime-graph-sync'
import { useWindowVisibilityEffects } from './app-shell/use-window-visibility-effects'
import { SpaceWindowStatePublisher } from './components/workspace-space/SpaceWindowStatePublisher'
import { PlainSshTerminalPanels } from './components/plain-ssh-terminal/PlainSshTerminalPanels'
import { installActiveWorktreeRemovalSuccessor } from './lib/active-worktree-removal-successor'

function App(): React.JSX.Element {
  const layout = useAppChromeLayout()
  const floatingWorkspace = useFloatingWorkspacePanel()
  const onboardingGate = useOnboardingAndFeatureTips()
  const clearUnreadDockBadge = useUnreadDockBadge(floatingWorkspace.open)

  useAppShellServices()
  // Load drafts before the startup chain so no failed step can skip them.
  useEffect(startNativeChatDraftLoad, [])
  useAppStartupHydration(onboardingGate.applyStartupOnboardingState)
  useAppSessionPersistence()
  useRuntimeGraphSync()
  usePersistedUIWriter()
  useDocumentAppearance()
  useWindowVisibilityEffects()
  useGlobalKeybindings({ layout, floatingWorkspace })
  // App owns active-selection removal; the Space window only mirrors selection.
  useEffect(() => installActiveWorktreeRemovalSuccessor(), [])

  // Portaled sheets/dialogs live outside .app-layout and need root offsets to clear Windows/Linux controls.
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--window-controls-width', WINDOW_CONTROLS_WIDTH)
    root.setProperty('--window-controls-height', WINDOW_CONTROLS_HEIGHT)
    root.setProperty('--mac-traffic-lights-width', MAC_TRAFFIC_LIGHTS_WIDTH)
  }, [])

  const { cancelReturnFocusFrame } = floatingWorkspace
  const setAppRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Cancel chrome cleanup work when the App root unmounts.
      if (!node) {
        cancelReturnFocusFrame()
        clearUnreadDockBadge()
      }
    },
    [cancelReturnFocusFrame, clearUnreadDockBadge]
  )

  return (
    <div
      ref={setAppRootNode}
      className="app-layout"
      style={
        {
          '--collapsed-sidebar-header-width': `${layout.collapsedSidebarHeaderWidth}px`,
          // Shared so surfaces can avoid the Windows/Linux window-controls overlay without hardcoding 138px everywhere.
          '--window-controls-width': WINDOW_CONTROLS_WIDTH,
          // Side-position activity bar uses this to push icons below the Windows/Linux window-controls overlay.
          '--window-controls-height': WINDOW_CONTROLS_HEIGHT,
          // Full-bleed surfaces use this to keep the macOS traffic lights uncovered.
          '--mac-traffic-lights-width': MAC_TRAFFIC_LIGHTS_WIDTH
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        <ConfirmationDialogProvider>
          <BrowserPagePrompts />
          <LinkRoutingPreferenceDialogProvider>
            <AppBackgroundServices />
            <SpaceWindowStatePublisher />
            <AppWorkspaceShell layout={layout} floatingWorkspace={floatingWorkspace} />
            <AppRootSurfaces
              floatingWorkspace={floatingWorkspace}
              onboardingGate={onboardingGate}
            />
            <BrowserWebAuthnAccountDialog />
          </LinkRoutingPreferenceDialogProvider>
        </ConfirmationDialogProvider>
        {createPortal(
          <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />,
          document.body
        )}
        <PlainSshTerminalPanels />
      </TooltipProvider>
      <SkillFreshnessNudge />
      <WorktreeBaseFallbackDialog />
      <ClaudeAccountSwitchDialog />
      <PinnedTabCloseDialog />
      <RunningTerminalCloseDialog />
      {/* Electron drag hit-testing follows DOM order, ignoring z-index; render controls last to keep them clickable. */}
      {hasCustomTitleBar && <WindowControls />}
    </div>
  )
}

export default App
