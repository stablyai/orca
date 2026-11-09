import { Minimize2, PanelRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { ActivityTitlebarControls } from '../components/activity/ActivityTitlebarControls'
import { useShortcutLabel } from '../hooks/useShortcutLabel'
import { useAppStore } from '../store'
import { selectVmBuildSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { selectActiveTerminalChromeState } from './active-terminal-chrome-selector'
import { hasCustomTitleBar } from './app-window-chrome'
import type { AppChromeLayout } from './use-app-chrome-layout'

export function RightSidebarToggle(): React.JSX.Element {
  const t = useTranslate()
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const rightSidebarShortcutLabel = useShortcutLabel('sidebar.right.toggle')
  // A build sheet keeps the sidebar closed (it has no workspace to show yet), so say why instead of doing nothing.
  const building = useAppStore(selectVmBuildSurfaceShown)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="sidebar-toggle mr-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={building ? undefined : toggleRightSidebar}
          aria-disabled={building || undefined}
          aria-label={t('auto.App.9e0b441a91', 'Toggle right sidebar')}
        >
          <PanelRight size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {building
          ? t(
              'auto.app.shell.TitlebarMainStrip.sidebarAfterBuild',
              'Available when the workspace is ready'
            )
          : t('auto.App.c184e056de', 'Toggle right sidebar ({{value0}})', {
              value0: rightSidebarShortcutLabel
            })}
      </TooltipContent>
    </Tooltip>
  )
}

export function TitlebarMainStrip({ layout }: { layout: AppChromeLayout }): React.JSX.Element {
  const t = useTranslate()
  const handleToggleExpand = (): void => {
    const { effectiveActiveTabId } = selectActiveTerminalChromeState(useAppStore.getState())
    if (!effectiveActiveTabId) {
      return
    }
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId: effectiveActiveTabId }
      })
    )
  }

  return (
    <>
      {layout.activeView === 'activity' ? (
        <ActivityTitlebarControls />
      ) : layout.creationLayoutActive ? null : (
        <div
          id="titlebar-tabs"
          className={`flex flex-1 min-w-0 self-stretch${!layout.workspaceChromeActive ? ' invisible pointer-events-none' : ''}`}
        />
      )}
      {layout.showTitlebarExpandButton && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="titlebar-icon-button"
              onClick={handleToggleExpand}
              aria-label={t('auto.App.c1cf0b0e4a', 'Collapse pane')}
              disabled={!layout.activeTabCanExpand}
            >
              <Minimize2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('auto.App.c1cf0b0e4a', 'Collapse pane')}
          </TooltipContent>
        </Tooltip>
      )}
      {/* The open sidebar already renders its close button. */}
      {layout.showRightSidebarControls && !layout.rightSidebarOpen ? <RightSidebarToggle /> : null}
      {/* Reserve the custom window-controls overlay’s width. */}
      {hasCustomTitleBar && <div className="window-controls-titlebar-spacer" />}
    </>
  )
}
