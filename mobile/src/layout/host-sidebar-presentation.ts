export type HostSidebarPresentation = 'hidden' | 'sidebar' | 'reveal'

export function getHostSidebarPresentation(
  showSidebar: boolean,
  detailHasContent: boolean,
  sidebarOpen: boolean
): HostSidebarPresentation {
  if (!showSidebar) {
    return 'hidden'
  }
  if (sidebarOpen || !detailHasContent) {
    return 'sidebar'
  }
  return 'reveal'
}
