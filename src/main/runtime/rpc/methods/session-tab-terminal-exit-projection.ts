import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import { retireTerminalSurfacesFromSnapshot } from '../../mobile-session-terminal-retirement'

/**
 * A client without the exit-state capability sees a kept, exited leaf exactly as it saw an exit
 * before main kept it: the surface omitted, plus a retirement proof for the handle it knew.
 */
export function projectSessionTabTerminalExits(
  payload: RuntimeMobileSessionTabsResult,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RuntimeMobileSessionTabsResult {
  if (clientCapabilities?.includes(SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY)) {
    return payload
  }
  const exitedByPtyId = new Map<string, RuntimeMobileSessionTerminalClientTab[]>()
  for (const tab of payload.tabs) {
    if (tab.type === 'terminal' && tab.exited) {
      const tabs = exitedByPtyId.get(tab.exited.ptyId) ?? []
      tabs.push(tab)
      exitedByPtyId.set(tab.exited.ptyId, tabs)
    }
  }
  let projected = payload
  for (const [ptyId, tabs] of exitedByPtyId) {
    const retired = retireTerminalSurfacesFromSnapshot({
      snapshot: projected,
      ptyId,
      exactSurfaces: tabs,
      exactOnly: true,
      retirementProofs: tabs.flatMap((tab) =>
        tab.exited?.terminal
          ? [
              {
                parentTabId: tab.parentTabId,
                leafId: tab.leafId,
                ptyId,
                terminal: tab.exited.terminal,
                ...(tab.exited.incarnationId ? { incarnationId: tab.exited.incarnationId } : {})
              }
            ]
          : []
      )
    })
    if (retired) {
      projected = {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retirement only filters and spreads the tabs it is given, so every retained tab is still one of this payload's client tabs.
        ...(retired.snapshot as RuntimeMobileSessionTabsResult),
        // Why: a per-client view must not advance the version the next real publish is gated on.
        snapshotVersion: payload.snapshotVersion
      }
    }
  }
  return projected
}
