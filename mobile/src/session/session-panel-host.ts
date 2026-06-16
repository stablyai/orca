// Pure master-detail panel-host logic for the mobile session screen. No React/native
// imports so the dock-vs-push decision and the active-panel state machine are
// unit-testable under node Vitest (KTD3/R8).

export type ActivePanel = 'sourceControl' | 'files' | 'pr' | null

// Toggle/swap reducer for the wide-layout dock: tapping the active panel closes it,
// tapping any other opens/swaps to it. Exactly one panel docks at a time (R2).
export function nextActivePanel(
  current: ActivePanel,
  tapped: Exclude<ActivePanel, null>
): ActivePanel {
  return tapped === current ? null : tapped
}

export type PanelAction =
  | { kind: 'dock'; next: ActivePanel }
  | { kind: 'push'; panel: Exclude<ActivePanel, null> }

// Wide layouts dock (toggle/swap the sidebar beside the terminal); narrow layouts
// push the panel's full-screen route (R3/R7). The caller maps a push to the concrete
// expo-router path + params via panelRouteDescriptor.
export function resolvePanelAction(args: {
  isWideLayout: boolean
  tapped: Exclude<ActivePanel, null>
  current: ActivePanel
}): PanelAction {
  if (args.isWideLayout) {
    return { kind: 'dock', next: nextActivePanel(args.current, args.tapped) }
  }
  return { kind: 'push', panel: args.tapped }
}

// Single source of truth for each panel's expo-router pathname pattern so narrow-push
// and any deep-linking agree; the caller supplies the [hostId]/[worktreeId] params.
export function panelRouteDescriptor(panel: Exclude<ActivePanel, null>): { pathname: string } {
  switch (panel) {
    case 'sourceControl':
      return { pathname: '/h/[hostId]/source-control/[worktreeId]' }
    case 'files':
      return { pathname: '/h/[hostId]/files/[worktreeId]' }
    case 'pr':
      return { pathname: '/h/[hostId]/pr/[worktreeId]' }
  }
}
