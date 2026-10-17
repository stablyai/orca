import { Minimize2, PanelLeft, PanelRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { ActivityTitlebarControls } from '../components/activity/ActivityTitlebarControls'
import { useShortcutLabel } from '../hooks/useShortcutLabel'
import { useAppStore } from '../store'
import { hasCustomTitleBar } from './app-window-chrome'
import type { AppChromeLayout } from './use-app-chrome-layout'

// Why: the toggle follows the activity sidebar to whichever edge it occupies, so its icon and label
// must name that edge — mirrors the RightSidebar header's own close button.
export function RightSidebarToggle({
  edge = 'right'
}: {
  edge?: 'left' | 'right'
}): React.JSX.Element {
  const toggleRightSidebar = useAppStore((s) => s.toggleRightSidebar)
  const rightSidebarShortcutLabel = useShortcutLabel('sidebar.right.toggle')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="sidebar-toggle mr-2"
          onClick={toggleRightSidebar}
          aria-label={
            edge === 'left'
              ? translate('menu.toggleLeftSidebar', 'Toggle Left Sidebar')
              : translate('auto.App.9e0b441a91', 'Toggle right sidebar')
          }
        >
          {edge === 'left' ? <PanelLeft size={16} /> : <PanelRight size={16} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {edge === 'left'
          ? translate('menu.toggleLeftSidebar', 'Toggle Left Sidebar')
          : translate('auto.App.c184e056de', 'Toggle right sidebar ({{value0}})', {
              value0: rightSidebarShortcutLabel
            })}
      </TooltipContent>
    </Tooltip>
  )
}

/** The titlebar's center/right strip: the tab-strip portal slot and the trailing chrome buttons. */
export function TitlebarMainStrip({ layout }: { layout: AppChromeLayout }): React.JSX.Element {
  const handleToggleExpand = (): void => {
    if (!layout.effectiveActiveTabId) {
      return
    }
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId: layout.effectiveActiveTabId }
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
              aria-label={translate('auto.App.c1cf0b0e4a', 'Collapse pane')}
              disabled={!layout.activeTabCanExpand}
            >
              <Minimize2 size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.App.c1cf0b0e4a', 'Collapse pane')}
          </TooltipContent>
        </Tooltip>
      )}
      {/* Why: the open right sidebar's header renders its own close button, so hide this duplicate. */}
      {/* Why: a left-mounted activity sidebar's re-expand toggle lives in the left header (TitlebarLeftControls). */}
      {layout.showRightSidebarControls &&
      !layout.rightSidebarOpen &&
      layout.activitySidebarEdge === 'right' ? (
        <RightSidebarToggle edge="right" />
      ) : null}
      {/* Why: reserve space so the Windows/Linux window-controls overlay doesn't obscure content. */}
      {hasCustomTitleBar && <div className="window-controls-titlebar-spacer" />}
    </>
  )
}
