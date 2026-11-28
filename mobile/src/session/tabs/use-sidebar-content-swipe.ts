import type { SidebarPageDrag } from './sidebar-page-drag'

const noop = () => {}

// The session's content is a page; natively there is no DOM to listen on (see the .web sibling).
export function useSidebarContentSwipe(
  _drag: SidebarPageDrag | null,
  _enabled: boolean
): (node: unknown) => void {
  return noop
}
