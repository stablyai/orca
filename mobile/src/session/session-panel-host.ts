export type ActivePanel = 'sourceControl' | 'files' | 'pr' | null

export function nextActivePanel(
  current: ActivePanel,
  tapped: Exclude<ActivePanel, null>
): ActivePanel {
  return tapped === current ? null : tapped
}

export type PanelAction =
  | { kind: 'dock'; next: ActivePanel }
  | { kind: 'push'; panel: Exclude<ActivePanel, null> }

export const SESSION_DOCK_MIN_MAIN_WIDTH = 360

export function shouldShowSessionHeaderChecksAction(args: {
  isFolderWorkspaceRoute: boolean
  repoContextLoaded: boolean
  hostedChecksSupported: boolean
}): boolean {
  // Offer hosted checks only for supported providers; otherwise the panel guard would silently close them.
  return !args.isFolderWorkspaceRoute && args.repoContextLoaded && args.hostedChecksSupported
}

export function canDockSessionPanel(args: {
  isWideLayout: boolean
  availableWidth: number
  dockWidth: number
  minMainWidth?: number
}): boolean {
  return (
    args.isWideLayout &&
    args.availableWidth >= args.dockWidth + (args.minMainWidth ?? SESSION_DOCK_MIN_MAIN_WIDTH)
  )
}

export function resolvePanelAction(args: {
  canDock: boolean
  tapped: Exclude<ActivePanel, null>
  current: ActivePanel
}): PanelAction {
  if (args.canDock) {
    return { kind: 'dock', next: nextActivePanel(args.current, args.tapped) }
  }
  return { kind: 'push', panel: args.tapped }
}

// Route PR pushes through the source-control hub’s pr tab; its standalone route only redirects.
export function panelRouteDescriptor(panel: Exclude<ActivePanel, null>): {
  pathname: string
  params?: Record<string, string>
} {
  switch (panel) {
    case 'sourceControl':
      return { pathname: '/h/[hostId]/source-control/[worktreeId]' }
    case 'files':
      return { pathname: '/h/[hostId]/files/[worktreeId]' }
    case 'pr':
      return { pathname: '/h/[hostId]/source-control/[worktreeId]', params: { tab: 'pr' } }
  }
}
