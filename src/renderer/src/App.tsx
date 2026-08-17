import { useCallback } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from './components/confirmation-dialog'
import { BrowserWebAuthnAccountDialog } from './components/browser-webauthn-account-dialog'
import { LinkRoutingPreferenceDialogProvider } from './components/link-routing-preference-dialog'
import { SkillFreshnessNudge } from './components/skills/SkillFreshnessNudge'
import PinnedTabCloseDialog from './components/terminal-pane/PinnedTabCloseDialog'
import RunningTerminalCloseDialog from './components/terminal-pane/RunningTerminalCloseDialog'
import WorktreeBaseFallbackDialog from './components/WorktreeBaseFallbackDialog'
import { useUnreadDockBadge } from './hooks/useUnreadDockBadge'
import { AppBackgroundServices } from './app-shell/AppBackgroundServices'
import { AppRootSurfaces } from './app-shell/AppRootSurfaces'
import { AppWorkspaceShell } from './app-shell/AppWorkspaceShell'
import { WindowControls } from './app-shell/WindowControls'
import { hasCustomTitleBar } from './app-shell/app-window-chrome'
import { useAppChromeLayout } from './app-shell/use-app-chrome-layout'
import { useAppSessionPersistence } from './app-shell/use-app-session-persistence'
import { useAppShellServices } from './app-shell/use-app-shell-services'
import { useAppStartupHydration } from './app-shell/use-app-startup-hydration'
import { useDocumentAppearance } from './app-shell/use-document-appearance'
import { useFloatingWorkspacePanel } from './app-shell/use-floating-workspace-panel'
import { useGlobalKeybindings } from './app-shell/use-global-keybindings'
import { useOnboardingAndFeatureTips } from './app-shell/use-onboarding-and-feature-tips'
import { usePersistedUIWriter } from './app-shell/use-persisted-ui-writer'
import { useRuntimeGraphSync } from './app-shell/use-runtime-graph-sync'
import { useWindowVisibilityEffects } from './app-shell/use-window-visibility-effects'

function App(): React.JSX.Element {
  const layout = useAppChromeLayout()
  const floatingWorkspace = useFloatingWorkspacePanel()
  const onboardingGate = useOnboardingAndFeatureTips()
  const clearUnreadDockBadge = useUnreadDockBadge()

  useAppShellServices()
  useAppStartupHydration(onboardingGate.applyStartupOnboardingState)
  useAppSessionPersistence()
  useRuntimeGraphSync()
  usePersistedUIWriter()
  useDocumentAppearance()
  useWindowVisibilityEffects()
  useGlobalKeybindings({ layout, floatingWorkspace })

  const { cancelReturnFocusFrame } = floatingWorkspace
  const setAppRootNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: these best-effort App chrome cleanups share the App root lifetime.
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
          '--window-controls-width': hasCustomTitleBar ? '138px' : '0px',
          // Side-position activity bar uses this to push icons below the Windows/Linux window-controls overlay.
          '--window-controls-height': hasCustomTitleBar ? '36px' : '0px'
        } as React.CSSProperties
      }
    >
      <TooltipProvider delayDuration={400}>
        <ConfirmationDialogProvider>
          <LinkRoutingPreferenceDialogProvider>
            <AppBackgroundServices />
            <AppWorkspaceShell layout={layout} floatingWorkspace={floatingWorkspace} />
            <AppRootSurfaces
              floatingWorkspace={floatingWorkspace}
              onboardingGate={onboardingGate}
            />
            <BrowserWebAuthnAccountDialog />
          </LinkRoutingPreferenceDialogProvider>
        </ConfirmationDialogProvider>
      </TooltipProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <SkillFreshnessNudge />
      <WorktreeBaseFallbackDialog />
      <PinnedTabCloseDialog />
      <RunningTerminalCloseDialog />
      {/* Why: Electron's drag-region hit-test is DOM-order-based (ignores z-index); render last so WindowControls stay clickable. */}
      {hasCustomTitleBar && <WindowControls />}
    </div>
  )
}

export default App
