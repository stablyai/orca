import type { BridgeInitRoute } from '../bridge/protocol/bridge-init-route'
import type { BridgeClearableRouteParam } from '../bridge/page-lifecycle/bridge-route-update'

/** Unsupported item navigation leaves the document alive and consumes only that request. */
export function reportPageRouteRefusal(
  issue: string,
  args: {
    route: BridgeInitRoute
    clear: (param: BridgeClearableRouteParam, value: string) => void
    updateNeeded: () => void
    documentFailed: () => void
  }
): void {
  if (issue !== 'bot-item-links-unsupported') {
    args.documentFailed()
    return
  }
  for (const param of ['paneKey', 'botItem'] as const) {
    const value = args.route.params?.[param]
    if (value !== undefined) {
      args.clear(param, value)
    }
  }
  args.updateNeeded()
}
