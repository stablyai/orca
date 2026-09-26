import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../../shared/runtime-types'
import type { TerminalSurfaceExit } from '../../../../shared/terminal-surface-exit'
import { retireTerminalSurfacesFromSnapshot } from '../../mobile-session-terminal-retirement'

type ExitedTerminalTab = RuntimeMobileSessionTerminalClientTab & { exited: TerminalSurfaceExit }

function isExitedTerminalTab(tab: RuntimeMobileSessionClientTab): tab is ExitedTerminalTab {
  return tab.type === 'terminal' && tab.exited !== undefined
}

/** A client sees only what happened, never the dead process's ids. */
function toClientExit({ exitCode, cause, exitedAt }: TerminalSurfaceExit): TerminalSurfaceExit {
  return { exitCode, cause, exitedAt }
}

/** The proof names the handle an older client knew; main's record carries it past the client shape. */
function retirementProofFor(tab: ExitedTerminalTab): RuntimeMobileSessionRetiredTerminalSurface[] {
  const exit = tab.exited
  if (
    !('ptyId' in exit) ||
    typeof exit.ptyId !== 'string' ||
    !('terminal' in exit) ||
    typeof exit.terminal !== 'string'
  ) {
    return []
  }
  const incarnationId =
    'incarnationId' in exit && typeof exit.incarnationId === 'string' ? exit.incarnationId : null
  return [
    {
      parentTabId: tab.parentTabId,
      leafId: tab.leafId,
      ptyId: exit.ptyId,
      terminal: exit.terminal,
      ...(incarnationId ? { incarnationId } : {})
    }
  ]
}

/**
 * The one step that turns main's exit record on a kept leaf into what a client may see. A capable
 * client gets `{exitCode, cause, exitedAt}`; any other client gets the leaf omitted plus a
 * retirement proof, exactly as before main kept it. Every session-tabs snapshot reaches a client
 * through here; `session.tabs.createTerminal` returns an unprojected tab, but a new leaf never has
 * a record.
 */
export function projectSessionTabTerminalExits(
  payload: RuntimeMobileSessionTabsResult,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): RuntimeMobileSessionTabsResult {
  const exitedTabs = payload.tabs.filter(isExitedTerminalTab)
  if (exitedTabs.length === 0) {
    return payload
  }
  if (clientCapabilities?.includes(SESSION_TABS_TERMINAL_EXIT_STATE_RUNTIME_CAPABILITY)) {
    return {
      ...payload,
      tabs: payload.tabs.map((tab) =>
        isExitedTerminalTab(tab) ? { ...tab, exited: toClientExit(tab.exited) } : tab
      )
    }
  }
  // Why drop the tab's own binding: the exact match must succeed for every exited leaf, because a
  // handle-less leaf left in an older client's view reads as a terminal starting forever.
  let projected: RuntimeMobileSessionTabsResult = {
    ...payload,
    tabs: payload.tabs.map((tab) => {
      if (!isExitedTerminalTab(tab)) {
        return tab
      }
      const { ptyId: _ptyId, ...unbound } = tab
      return unbound
    })
  }
  for (const tab of exitedTabs) {
    const retired = retireTerminalSurfacesFromSnapshot({
      snapshot: projected,
      ptyId: tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? '',
      exactSurfaces: [tab],
      exactOnly: true,
      retirementProofs: retirementProofFor(tab)
    })
    if (retired) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retirement only filters and spreads the tabs it is given, so every retained tab is still one of this payload's client tabs.
      projected = retired.snapshot as RuntimeMobileSessionTabsResult
    }
  }
  // Why: a per-client view must not advance the version the next real publish is gated on.
  return { ...projected, snapshotVersion: payload.snapshotVersion }
}
