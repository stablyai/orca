import type { LegacyPaneKeyAliasEntry } from '../../../shared/persisted-state-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { MigrationUnsupportedPtyEntry } from '../../../shared/agent-status-types'

import type { PaneAliasNormalizationOptions } from './pane-identity-migration'

export {
  type WorkspaceSessionPaneIdentityRemap,
  remapSshRemotePtyLeaseLeafIds,
  normalizePersistedPaneIdentityState
} from './persisted-pane-identity-state'
import type { SessionUnitReader } from '../../../shared/session-unit-reader'

import { rememberSessionPaneAliasRecipes } from './session-pane-alias-recipes'

import { agentHookServer } from '../../agent-hooks/server'

import {
  createLazyTerminalTabLookup,
  collectLegacyPaneKeyAliasesForTab
} from './pane-identity-migration'
import { normalizeTerminalLayoutSnapshotForPersistence } from './terminal-layout-normalization'

export {
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys
} from './pane-key-remapping'

export function normalizeWorkspaceSessionPaneIdentities(
  session: WorkspaceSessionState,
  priorLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {},
  options: PaneAliasNormalizationOptions & { skipAliasTabIds?: ReadonlySet<string> } = {}
): {
  session: WorkspaceSessionState
  changed: boolean
  leafIdByInputLeafIdByTabId: Map<string, Map<string, string>>
  leafIdByPtyIdByTabId: Map<string, Map<string, string>>
  migrationUnsupportedEntries: MigrationUnsupportedPtyEntry[]
  legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[]
} {
  const lookup = createLazyTerminalTabLookup(session)
  let layouts = session.terminalLayoutsByTabId
  const result = normalizePaneIdentityUnits(
    {
      layout: (tabId) => session.terminalLayoutsByTabId[tabId],
      prior: (tabId) => priorLayoutsByTabId[tabId],
      tab: (tabId) => lookup.get(tabId),
      write: (tabId, layout) => {
        if (layout !== layouts[tabId]) {
          if (layouts === session.terminalLayoutsByTabId) {
            layouts = { ...layouts }
          }
          layouts[tabId] = layout
        }
      }
    },
    Object.keys(session.terminalLayoutsByTabId ?? {}),
    options
  )
  return {
    ...result,
    session:
      layouts === session.terminalLayoutsByTabId
        ? session
        : { ...session, terminalLayoutsByTabId: layouts }
  }
}

export function normalizeSessionPaneUnits(
  reader: SessionUnitReader,
  tabIds: Iterable<string>,
  options: PaneAliasNormalizationOptions & { skipAliasTabIds?: ReadonlySet<string> } = {},
  priorLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
) {
  return normalizePaneIdentityUnits(
    {
      layout: (tabId) => reader.unit('terminalLayoutsByTabId', tabId).value,
      prior: (tabId) =>
        priorLayoutsByTabId
          ? priorLayoutsByTabId[tabId]
          : reader.unit('terminalLayoutsByTabId', tabId, 'prior').value,
      tab: (tabId) => reader.terminalTab(tabId),
      write: (tabId, layout) =>
        reader.write('terminalLayoutsByTabId', tabId, { present: true, value: layout })
    },
    tabIds,
    options
  )
}

type PaneIdentityInputs = {
  layout: (tabId: string) => TerminalLayoutSnapshot | undefined
  prior: (tabId: string) => TerminalLayoutSnapshot | undefined
  tab: (tabId: string) => TerminalTab | undefined
  write: (tabId: string, layout: TerminalLayoutSnapshot) => void
}

function normalizePaneIdentityUnits(
  inputs: PaneIdentityInputs,
  tabIds: Iterable<string>,
  options: PaneAliasNormalizationOptions & { skipAliasTabIds?: ReadonlySet<string> }
) {
  let changed = false
  const leafIdByInputLeafIdByTabId = new Map<string, Map<string, string>>()
  const leafIdByPtyIdByTabId = new Map<string, Map<string, string>>()
  const legacyPaneKeyAliasEntries: LegacyPaneKeyAliasEntry[] = []
  for (const tabId of tabIds) {
    const layout = inputs.layout(tabId)
    if (!layout) {
      continue
    }
    const normalized = normalizeTerminalLayoutSnapshotForPersistence(layout, inputs.prior(tabId))
    inputs.write(tabId, normalized.snapshot)
    leafIdByInputLeafIdByTabId.set(tabId, normalized.leafIdByInputLeafId)
    if (!options.skipAliasTabIds?.has(tabId)) {
      const tab = inputs.tab(tabId)
      const tabAliasEntries = collectLegacyPaneKeyAliasesForTab({
        tabId,
        tab,
        inputLayout: layout,
        normalizedLayout: normalized.snapshot,
        leafIdByInputLeafId: normalized.leafIdByInputLeafId
      })
      rememberSessionPaneAliasRecipes(normalized.snapshot, tabAliasEntries)
      // Split layouts can exceed V8's argument limit if aliases are spread into push.
      for (const entry of tabAliasEntries) {
        if (
          options.registerAliases !== false &&
          !agentHookServer.hasPaneKeyAlias(entry.legacyPaneKey, entry.stablePaneKey, entry.ptyId)
        ) {
          agentHookServer.registerPaneKeyAlias(
            entry.legacyPaneKey,
            entry.stablePaneKey,
            entry.ptyId
          )
        }
        if (entry.ptyId) {
          legacyPaneKeyAliasEntries.push({ ...entry, ptyId: entry.ptyId })
        } else {
          options.collectUnboundPaneAlias?.(entry)
        }
      }
    }
    const leafIdByPtyId = new Map<string, string>()
    const duplicatePtyIds = new Set<string>()
    for (const [leafId, ptyId] of Object.entries(normalized.snapshot.ptyIdsByLeafId ?? {})) {
      if (duplicatePtyIds.has(ptyId)) {
        continue
      }
      if (leafIdByPtyId.has(ptyId)) {
        leafIdByPtyId.delete(ptyId)
        duplicatePtyIds.add(ptyId)
        continue
      }
      leafIdByPtyId.set(ptyId, leafId)
    }
    leafIdByPtyIdByTabId.set(tabId, leafIdByPtyId)
    changed ||= normalized.changed
  }
  return {
    changed,
    leafIdByInputLeafIdByTabId,
    leafIdByPtyIdByTabId,
    // Alias replacement still requires callers to clear the legacy restart-required field.
    migrationUnsupportedEntries: [],
    legacyPaneKeyAliasEntries
  }
}

/** Hostless acknowledgement keys must keep their first tab mapping. */
