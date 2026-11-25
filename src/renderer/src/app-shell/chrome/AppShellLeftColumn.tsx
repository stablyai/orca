import { Fragment } from 'react'
import type React from 'react'
import type { AppChromeLayout } from './use-app-chrome-layout'

type LeftColumnLayout = Pick<
  AppChromeLayout,
  | 'appRailVisible'
  | 'showSidebar'
  | 'sidebarOpen'
  | 'listHiddenByRailPage'
  | 'leftTitlebarChromeLayout'
  | 'leftSidebarStyle'
>

/**
 * The left titlebar, the optional app rail and the workspace list.
 * Why one keyed slot with the rail on: the list (its focus, local state, and dialogs such as Workspace details with an
 * unsaved draft, plus the Workspace Board) must survive view changes, so with the rail on it always sits in the
 * column's keyed viewport. An active workspace, a rail page or the header mounting must never move it, because moving
 * it would remount it. On a rail page the viewport collapses to zero width.
 * With the rail off the DOM is exactly the plain sidebar layout (the column viewport when the header mounts, else
 * direct). A rail flag flip therefore keeps the list only while the header is mounted; with no header it remounts
 * once. That is accepted: the in-app toggle lives on Settings, where the list is not mounted, and at startup the
 * header is mounted because the list defaults open.
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
  const listInColumn = layout.showSidebar && (railOn || shouldMount)
  const listDirect = layout.showSidebar && !railOn && !shouldMount
  // The header follows the chrome layout, not the list's slot: with the rail on the list is always in the column.
  const header =
    listInColumn && shouldMount ? (
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
            // Rail-on only, so the flag-off DOM stays exactly the plain layout.
            data-left-column-list={railOn ? '' : undefined}
            className={
              railOn
                ? `flex min-h-0 shrink-0${
                    layout.sidebarOpen
                      ? ' mt-(--app-header-height)'
                      : layout.listHiddenByRailPage
                        ? ' w-0 overflow-hidden'
                        : ' w-0'
                  }`
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
