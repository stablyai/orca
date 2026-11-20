import { Fragment } from 'react'
import type React from 'react'
import type { AppChromeLayout } from './use-app-chrome-layout'

type LeftColumnLayout = Pick<
  AppChromeLayout,
  'appRailVisible' | 'showSidebar' | 'sidebarOpen' | 'leftTitlebarChromeLayout' | 'leftSidebarStyle'
>

/**
 * The left titlebar, the optional app rail and the workspace list.
 * Why fixed, keyed slots: the rail flag can flip at any time (a late Settings publish). The list, and everything it hosts
 * (its focus, local state and dialogs such as Workspace details with an unsaved draft), must survive that flip, so the
 * list sits in the same place in both modes: inside the column's keyed viewport when the column header is mounted, else
 * directly at this level, keyed, exactly where the plain layout puts it. Never wrap the list differently per mode.
 * With the flag off the DOM is exactly the plain sidebar layout.
 */
export function AppShellLeftColumn({
  layout,
  titlebarLeftControls,
  rail,
  list
}: {
  layout: LeftColumnLayout
  titlebarLeftControls: React.ReactNode
  rail: React.ReactNode
  list: React.ReactNode
}): React.JSX.Element {
  const railOn = layout.appRailVisible
  const { shouldMount, isFloating } = layout.leftTitlebarChromeLayout
  const listInColumn = layout.showSidebar && shouldMount
  const listDirect = layout.showSidebar && !shouldMount
  const header = listInColumn ? (
    <div
      key="titlebar-left"
      // The floating header covers the center border; restore the seam and size to its own controls.
      className={
        railOn
          ? // Why: first in the DOM so Tab follows the screen (titlebar, rail, list); spans rail and list from this
            // column's live width, so drag resizes still track.
            `titlebar-left absolute top-0 left-0 z-10${
              isFloating ? ' titlebar-left-floating w-max border-r border-border' : ' right-0'
            }`
          : `titlebar-left${
              isFloating
                ? ' titlebar-left-floating absolute top-0 left-0 z-10 w-max border-r border-border'
                : ''
            }`
      }
      style={
        railOn
          ? layout.sidebarOpen
            ? layout.leftSidebarStyle
            : undefined
          : {
              // Why: custom sidebar appearances are scoped to the sidebar root; mirror those vars onto the header in the same left-column panel.
              ...(layout.sidebarOpen ? layout.leftSidebarStyle : undefined),
              // Why: size from the wrapper's live width so the header tracks in-flight drag resizes (persisted to Zustand only on mouseup).
              width: layout.sidebarOpen ? '100%' : undefined
            }
      }
    >
      {titlebarLeftControls}
    </div>
  ) : null
  const column =
    railOn || listInColumn ? (
      // Remove the collapsed header from flex layout so panes reclaim the left edge.
      <div
        key="left-column"
        className={
          railOn
            ? 'relative flex min-h-0 shrink-0 flex-row'
            : `flex min-h-0 flex-col shrink-0${layout.sidebarOpen ? '' : ' relative w-0 overflow-visible'}`
        }
      >
        {header}
        {railOn ? (
          // One stable position across views so a page switch never remounts the rail and drops keyboard focus.
          <div key="app-rail" className="flex min-h-0 shrink-0 flex-col">
            {/* The left titlebar covers this gap so the traffic-light row spans rail and list. */}
            {shouldMount ? <div className="h-(--app-header-height) shrink-0" /> : null}
            {rail}
          </div>
        ) : null}
        {listInColumn ? (
          // Keep a shrinkable flex viewport below the fixed header so the sidebar can scroll.
          <div
            key="worktree-list"
            className={
              railOn
                ? `flex min-h-0 shrink-0${layout.sidebarOpen ? ' mt-(--app-header-height)' : ' w-0'}`
                : 'flex min-h-0 flex-1'
            }
          >
            {list}
          </div>
        ) : null}
      </div>
    ) : null
  return (
    <>
      {column}
      {listDirect ? <Fragment key="worktree-list-direct">{list}</Fragment> : null}
    </>
  )
}
