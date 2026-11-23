import { Suspense, useCallback, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { lazyWithRetry as lazy } from './app-shell/startup/lazy-with-retry'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from './components/dismiss/confirmation/confirmation-dialog'
import { BrowserPagePrompts } from './components/browser-pane/page-prompts/browser-page-prompts'
import { LinkRoutingPreferenceDialogProvider } from './components/link-actions/link-routing-preference-dialog'
import { AppBackgroundServices } from './app-shell/AppBackgroundServices'
import { AppRootSurfaces } from './app-shell/AppRootSurfaces'
import { AppWorkspaceShell } from './app-shell/AppWorkspaceShell'
import { WindowControls } from './app-shell/chrome/WindowControls'
import {
  MAC_TRAFFIC_LIGHTS_WIDTH,
  WINDOW_CONTROLS_HEIGHT,
  WINDOW_CONTROLS_WIDTH,
  hasCustomTitleBar,
  supportsLinuxTilingWindowMode
} from './app-shell/chrome/app-window-chrome'
import { useAppChromeLayout } from './app-shell/chrome/use-app-chrome-layout'
import { useAppSessionPersistence } from './app-shell/storage/use-app-session-persistence'
import { useAppShellServices } from './app-shell/use-app-shell-services'
import { useAppStartupHydration } from './app-shell/startup/use-app-startup-hydration'
import { startNativeChatDraftLoad } from './components/native-chat/drafts/native-chat-draft-startup'
import { runWslMoveRendererStoreRewrites } from './lib/workspace/persistence/wsl-move-renderer-store-rewrites'
import { runWslDriveUncRendererStoreRewrites } from './lib/workspace/persistence/wsl-drive-unc-renderer-store-rewrites'
import { useDocumentAppearance } from './app-shell/appearance/use-document-appearance'
import { useFloatingWorkspacePanel } from './components/floating-terminal/workspace/use-floating-workspace-panel'
import { useGlobalKeybindings } from './hooks/app-commands/use-global-keybindings'
import { useOnboardingAndFeatureTips } from './app-shell/startup/use-onboarding-and-feature-tips'
import { usePersistedUIWriter } from './app-shell/storage/use-persisted-ui-writer'
import { useRuntimeGraphSync } from './runtime/sync-runtime-graph/use-runtime-graph-sync'
import { useWindowVisibilityEffects } from './app-shell/chrome/use-window-visibility-effects'
import { SpaceWindowStatePublisher } from './components/workspace-space/SpaceWindowStatePublisher'
import { AddToChatPointMenuHost } from './components/native-chat/selection-quotes/AddToChatMenu'
import { installActiveWorktreeRemovalSuccessor } from './lib/workspace/activation/active-worktree-removal-successor'
import { useAppStore } from './store'

const PluginUpdateReviewHost = lazy(() =>
  import('./components/plugins/dialogs/PluginUpdateReviewHost').then((m) => ({
    default: m.PluginUpdateReviewHost
  }))
)
const BrowserWebAuthnAccountDialog = lazy(() =>
  import('./components/browser-pane/page-prompts/browser-webauthn-account-dialog').then((m) => ({
    default: m.BrowserWebAuthnAccountDialog
  }))
)
const BrowserExtensionInstallDialog = lazy(() =>
  import('./components/browser-pane/page-prompts/browser-extension-install-dialog').then((m) => ({
    default: m.BrowserExtensionInstallDialog
  }))
)
const SkillFreshnessNudge = lazy(() =>
  import('./components/skills/freshness/SkillFreshnessNudge').then((m) => ({
    default: m.SkillFreshnessNudge
  }))
)
const PinnedTabCloseDialog = lazy(
  () => import('./components/terminal-pane/layout/close/PinnedTabCloseDialog')
)
const RunningTerminalCloseDialog = lazy(
  () => import('./components/terminal-pane/layout/close/RunningTerminalCloseDialog')
)
const WorktreeBaseFallbackDialog = lazy(
  () => import('./components/sidebar/workspace-creation/base-ref-update/WorktreeBaseFallbackDialog')
)
const ClaudeAccountSwitchDialog = lazy(
  () => import('./components/provider-accounts/claude/ClaudeAccountSwitchDialog')
)
const PlainSshTerminalPanels = lazy(() =>
  import('./components/plain-ssh-terminal/PlainSshTerminalPanels').then((m) => ({
    default: m.PlainSshTerminalPanels
  }))
)
const PluginShotReplayMount = lazy(() =>
  import('./components/plugins/view/PluginShotReplayMount').then((m) => ({
    default: m.PluginShotReplayMount
  }))
)

function App(): React.JSX.Element {
  const layout = useAppChromeLayout()
  const tilingWindowMode = useAppStore(
    (s) => supportsLinuxTilingWindowMode && s.settings?.linuxTilingWindowMode === true
  )
  const windowControlsWidth = tilingWindowMode ? '46px' : WINDOW_CONTROLS_WIDTH
  const compactWorkspaceChrome = tilingWindowMode && layout.workspaceChromeActive
  const windowControlsHeight = compactWorkspaceChrome
    ? 'var(--workspace-tab-row-height)'
    : WINDOW_CONTROLS_HEIGHT
  const layoutStyle: React.CSSProperties & Record<`--${string}`, string> = {
    '--collapsed-sidebar-header-width': `${layout.collapsedSidebarHeaderWidth}px`,
    ...(compactWorkspaceChrome && { '--app-header-height': windowControlsHeight })
  }
  const floatingWorkspace = useFloatingWorkspacePanel()
  const onboardingGate = useOnboardingAndFeatureTips()

  useAppShellServices()
  // Load drafts before the startup chain so no failed step can skip them.
  useEffect(startNativeChatDraftLoad, [])
  // Committed WSL moves only: the list is empty otherwise, and always with the internal gate closed.
  useEffect(() => void runWslMoveRendererStoreRewrites(), [])
  // A Windows-drive conversion's own stores, after the restart that converted the project.
  useEffect(() => void runWslDriveUncRendererStoreRewrites(), [])
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
  useLayoutEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--window-controls-width', windowControlsWidth)
    root.setProperty('--window-controls-height', windowControlsHeight)
    root.setProperty('--mac-traffic-lights-width', MAC_TRAFFIC_LIGHTS_WIDTH)
  }, [windowControlsHeight, windowControlsWidth])

  const { cancelReturnFocusFrame } = floatingWorkspace
  const setAppRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Cancel chrome cleanup work when the App root unmounts.
      if (!node) {
        cancelReturnFocusFrame()
      }
    },
    [cancelReturnFocusFrame]
  )

  return (
    <div
      ref={setAppRootNode}
      className="app-layout"
      data-linux-tiling-window-mode={tilingWindowMode || undefined}
      style={layoutStyle}
    >
      <TooltipProvider>
        <ConfirmationDialogProvider>
          <BrowserPagePrompts />
          <AddToChatPointMenuHost />
          <LinkRoutingPreferenceDialogProvider>
            <AppBackgroundServices />
            <SpaceWindowStatePublisher />
            <AppWorkspaceShell layout={layout} floatingWorkspace={floatingWorkspace} />
            <AppRootSurfaces
              floatingWorkspace={floatingWorkspace}
              onboardingGate={onboardingGate}
            />
            <Suspense fallback={null}>
              <BrowserWebAuthnAccountDialog />
              <BrowserExtensionInstallDialog />
            </Suspense>
          </LinkRoutingPreferenceDialogProvider>
        </ConfirmationDialogProvider>
        {createPortal(
          <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />,
          document.body
        )}
        <Suspense fallback={null}>
          <PlainSshTerminalPanels />
          <PluginShotReplayMount />
          <PluginUpdateReviewHost />
        </Suspense>
      </TooltipProvider>
      <Suspense fallback={null}>
        <SkillFreshnessNudge />
        {/* One account-link confirm at a time, over whatever screen the owner is on. */}
        <WorktreeBaseFallbackDialog />
        <ClaudeAccountSwitchDialog />
        <PinnedTabCloseDialog />
        <RunningTerminalCloseDialog />
      </Suspense>
      {/* Electron drag hit-testing follows DOM order, ignoring z-index; render controls last to keep them clickable. */}
      {hasCustomTitleBar && <WindowControls closeOnly={tilingWindowMode} />}
    </div>
  )
}

export default App
