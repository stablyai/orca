export type LeftTitlebarChromeLayoutInput = {
  workspaceChromeActive: boolean
  stackedSidebarOpen: boolean
  creationLayoutActive: boolean
  sidebarOpen: boolean
}

export type LeftTitlebarChromeLayout = {
  shouldMount: boolean
  isFloating: boolean
}

export function resolveLeftTitlebarChromeLayout({
  workspaceChromeActive,
  stackedSidebarOpen,
  creationLayoutActive,
  sidebarOpen
}: LeftTitlebarChromeLayoutInput): LeftTitlebarChromeLayout {
  const shouldMount = workspaceChromeActive || stackedSidebarOpen || creationLayoutActive
  return {
    shouldMount,
    isFloating: shouldMount && !sidebarOpen && !stackedSidebarOpen
  }
}
