import { createContext } from 'react'

/** The sidebar's drag phases for a swipe the page recognises itself; null while docked. */
export type SidebarPageDrag = {
  begin: () => void
  follow: (translationX: number) => void
  end: (velocityX: number, success: boolean) => void
}

/** Lets the session's content open the sidebar with a swipe; the surface provides it. */
export const SidebarPageDragContext = createContext<SidebarPageDrag | null>(null)
