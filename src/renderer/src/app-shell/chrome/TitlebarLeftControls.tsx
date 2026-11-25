import { useCallback, useLayoutEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight, MoreHorizontal } from 'lucide-react'
import { SidebarToggleIcon } from '@/components/icons/SidebarToggleIcon'
import logo from '../../../../../resources/logo.svg'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { keepPaneFocusPressProps } from '@/lib/overlay-interaction/focus-keeping-press'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { shouldShowWorktreeHistoryControls } from './titlebar-worktree-history-controls'
import {
  canGoBackWorktreeHistory,
  canGoForwardWorktreeHistory
} from '@/store/slices/ui/workspace-navigation-history'
import { useShortcutLabel } from '../../lib/keyboard/useShortcutLabel'
import { useAppStore } from '../../store/index'
import { showWorkspaceListThen } from '../../components/app-rail/app-rail-navigation'
import { selectAppRailVisible } from '../../components/app-rail/app-rail-layout'
import { hasCustomTitleBar, hasMacTrafficLights } from './app-window-chrome'
import type { AppChromeLayout } from './use-app-chrome-layout'
import {
  registerTitlebarSidebarToggle,
  unregisterTitlebarSidebarToggle
} from './titlebar-sidebar-toggle-ref'
import { useTitlebarHeaderFoldLevel } from './titlebar-chrome-fold'

type TitlebarControlRole = 'menu' | 'toggle' | 'back' | 'forward'
type TitlebarControls = Record<TitlebarControlRole, HTMLButtonElement | null>
const TITLEBAR_CONTROL_ROLES: readonly TitlebarControlRole[] = ['menu', 'toggle', 'back', 'forward']

// Every mounted instance's buttons. The column header and the page titlebar row can briefly both hold one during a view
// switch, and the old one can unmount after the new one mounted, so focus is restored against whichever is live.
const liveTitlebarControls = new Set<TitlebarControls>()

function isFocusableControl(control: HTMLButtonElement | null): control is HTMLButtonElement {
  return control !== null && control.isConnected && !control.disabled
}

function restoreTitlebarFocus(role: TitlebarControlRole): void {
  const active = document.activeElement
  // Anything focused since the control left (the user, a page, a dialog) wins.
  if (active !== null && active !== document.body) {
    return
  }
  for (const pick of [role, 'toggle'] as const) {
    for (const controls of liveTitlebarControls) {
      const control = controls[pick]
      if (isFocusableControl(control)) {
        control.focus({ preventScroll: true })
        return
      }
    }
  }
}

/**
 * With the rail on, these controls move between the column header and the page titlebar row as views switch, which
 * remounts them. Keep a keyboard user's focus on the same control (or the toggle, when that control is missing or
 * disabled in the new view, e.g. Forward at the end of history) instead of dropping it to the body.
 */
function useTitlebarControlFocusHandoff(controlsRef: React.RefObject<TitlebarControls>): void {
  useLayoutEffect(() => {
    // One object per instance; the buttons' refs fill it in before this runs and are cleared only after cleanup.
    const controls = controlsRef.current
    liveTitlebarControls.add(controls)
    return () => {
      liveTitlebarControls.delete(controls)
      if (!selectAppRailVisible(useAppStore.getState())) {
        return
      }
      // Why: a removed subtree's layout cleanups run before its nodes leave the DOM, so focus is still readable.
      const active = document.activeElement
      const role = TITLEBAR_CONTROL_ROLES.find(
        (candidate) => controls[candidate] !== null && controls[candidate] === active
      )
      if (role) {
        // After this commit (and any follow-up commit that mounts the moved controls) has painted.
        requestAnimationFrame(() => restoreTitlebarFocus(role))
      }
    }
  }, [controlsRef])
}

/** Reuse left chrome across full-width and sidebar-width headers so controls/popovers stay consistent. */
export function TitlebarLeftControls({ layout }: { layout: AppChromeLayout }): React.JSX.Element {
  const t = useTranslate()
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const canGoBackWorktree = useAppStore(canGoBackWorktreeHistory)
  const canGoForwardWorktree = useAppStore(canGoForwardWorktreeHistory)
  const leftSidebarShortcutLabel = useShortcutLabel('sidebar.left.toggle')
  const historyBackShortcutLabel = useShortcutLabel('worktree.history.back')
  const historyForwardShortcutLabel = useShortcutLabel('worktree.history.forward')
  // Owned reference for focus fallbacks (the app rail), instead of a shared CSS-class query.
  const registeredToggleRef = useRef<HTMLButtonElement | null>(null)
  const controlsRef = useRef<TitlebarControls>({
    menu: null,
    toggle: null,
    back: null,
    forward: null
  })
  const menuButtonRef = useCallback((node: HTMLButtonElement | null) => {
    controlsRef.current.menu = node
  }, [])
  const backButtonRef = useCallback((node: HTMLButtonElement | null) => {
    controlsRef.current.back = node
  }, [])
  const forwardButtonRef = useCallback((node: HTMLButtonElement | null) => {
    controlsRef.current.forward = node
  }, [])
  const sidebarToggleRef = useCallback((node: HTMLButtonElement | null) => {
    controlsRef.current.toggle = node
    if (node) {
      registeredToggleRef.current = node
      registerTitlebarSidebarToggle(node)
    } else if (registeredToggleRef.current) {
      unregisterTitlebarSidebarToggle(registeredToggleRef.current)
      registeredToggleRef.current = null
    }
  }, [])
  useTitlebarControlFocusHandoff(controlsRef)
  // Only the floating header folds: it shares the top-left pane's strip.
  const storedFoldLevel = useTitlebarHeaderFoldLevel()
  const foldLevel = layout.leftTitlebarChromeLayout.isFloating ? storedFoldLevel : 0

  return (
    // Measure the whole row for tab-strip spacing. w-max prevents the collapsed w-0 wrapper shrinking Windows text to one glyph.
    <div
      ref={layout.titlebarLeftControlsRef}
      data-titlebar-fold-level={foldLevel}
      className={`flex h-full shrink-0 items-center${
        layout.leftTitlebarChromeLayout.isFloating ? ' w-max' : ' w-full'
      }`}
    >
      <div className="flex h-full items-center gap-1">
        {hasMacTrafficLights && !layout.isFullScreen ? (
          <div className="titlebar-traffic-light-pad" />
        ) : hasCustomTitleBar ? (
          /* Replace native Windows/Linux chrome with logo and application-menu access. */
          <>
            <img src={logo} alt="" aria-hidden className="titlebar-logo" />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="titlebar-icon-button"
                  ref={menuButtonRef}
                  aria-label={t('auto.App.8b0b8eb54f', 'Application menu')}
                  onClick={() => window.api.ui.popupMenu()}
                  {...keepPaneFocusPressProps}
                >
                  <MoreHorizontal size={16} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {t('auto.App.8b0b8eb54f', 'Application menu')}
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <div className="pl-2" />
        )}
        {layout.showSidebar &&
          !hasCustomTitleBar &&
          layout.showTitlebarAppName &&
          foldLevel === 0 && (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className="titlebar-app-name"
                  aria-label={t('auto.App.5096cbbc86', 'Orca')}
                  data-titlebar-fold-step="1"
                >
                  <span className="titlebar-app-name-main">{t('auto.App.5096cbbc86', 'Orca')}</span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => {
                    void updateSettings({ showTitlebarAppName: false })
                  }}
                >
                  {t('auto.App.e81217c1b7', 'Hide App Name')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )}
        {layout.showSidebar && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                ref={sidebarToggleRef}
                className="sidebar-toggle titlebar-icon-button"
                onClick={() => {
                  if (!showWorkspaceListThen(useAppStore)) {
                    toggleSidebar()
                  }
                }}
                {...keepPaneFocusPressProps}
                aria-label={t('auto.App.e4b9e7dff7', 'Toggle sidebar')}
              >
                <SidebarToggleIcon side="left" size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.App.ce37cf5279', 'Toggle sidebar ({{value0}})', {
                value0: leftSidebarShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {/* Show shared workspace/page history wherever its shortcut is available. */}
      {/* Folded, Back stays (dimmed without history so nothing shifts); Forward and then Back move into the pane ⋯. */}
      {shouldShowWorktreeHistoryControls(layout.activeView) && foldLevel < 2 && (
        // Collapsed headers shrink-wrap, so ml-auto alone cannot leave a history-button gutter.
        // pl-3 keeps the arrows at their old x now that the titlebar icons are 24px wide.
        <div className="ml-auto mr-3 flex items-center pl-3" data-titlebar-fold-step="2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="sidebar-toggle sidebar-toggle-compact"
                onClick={() => useAppStore.getState().goBackWorktree()}
                disabled={!canGoBackWorktree}
                ref={backButtonRef}
                aria-label={t('auto.App.064bd07810', 'Go back')}
              >
                <ArrowLeft size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t('auto.App.fe21e8f6f5', 'Go back ({{value0}})', {
                value0: historyBackShortcutLabel
              })}
            </TooltipContent>
          </Tooltip>
          {foldLevel === 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="sidebar-toggle sidebar-toggle-compact"
                  data-titlebar-fold-step="1"
                  onClick={() => useAppStore.getState().goForwardWorktree()}
                  disabled={!canGoForwardWorktree}
                  ref={forwardButtonRef}
                  aria-label={t('auto.App.cf9099fe98', 'Go forward')}
                >
                  <ArrowRight size={12} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {t('auto.App.f7aa73e785', 'Go forward ({{value0}})', {
                  value0: historyForwardShortcutLabel
                })}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  )
}
