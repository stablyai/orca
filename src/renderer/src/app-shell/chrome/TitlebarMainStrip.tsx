import { Minimize2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { ActivityTitlebarControls } from '../../components/activity/ActivityTitlebarControls'
import { useAppStore } from '../../store/index'
import { RightSidebarToggle } from './RightSidebarToggle'
import { selectActiveTerminalChromeState } from './active-terminal-chrome-selector'
import { hasCustomTitleBar } from './app-window-chrome'
import type { AppChromeLayout } from './use-app-chrome-layout'

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
      {layout.workspaceSidebarOnLeft &&
      layout.showRightSidebarControls &&
      !layout.rightSidebarOpen ? (
        <RightSidebarToggle />
      ) : null}
      {/* Reserve the custom window-controls overlay’s width. */}
      {hasCustomTitleBar && <div className="window-controls-titlebar-spacer" />}
    </>
  )
}
