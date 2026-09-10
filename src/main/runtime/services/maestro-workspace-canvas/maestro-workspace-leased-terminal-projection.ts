import { createHash } from 'node:crypto'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import { stripBrailleSpinnerGlyphs } from '../../../../shared/terminal-output-side-effects'
import type {
  RuntimeMaestroWorkspaceCanvasScope,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../../shared/runtime-types'

type LeaseLookup = (terminal: RuntimeTerminalSummary) => MaestroTerminalLease | undefined

function matchingLease(
  scope: RuntimeMaestroWorkspaceCanvasScope,
  terminal: RuntimeTerminalSummary,
  getLease: LeaseLookup
): MaestroTerminalLease | null {
  if (!terminal.connected || !terminal.tabId || !terminal.leafId) {
    return null
  }
  const lease = getLease(terminal)
  const processIncarnation =
    terminal.ptyId && terminal.incarnationId
      ? `${terminal.ptyId}:${terminal.incarnationId}`
      : terminal.incarnationId
  if (
    !lease ||
    lease.executionHostId !== scope.execution_host_id ||
    lease.workspaceKey !== scope.workspace_key ||
    !(
      lease.terminalHandle === terminal.handle ||
      (lease.tabId === terminal.tabId &&
        lease.ptyIncarnation !== null &&
        lease.ptyIncarnation === processIncarnation)
    )
  ) {
    return null
  }
  return lease
}

function terminalProjectionTitle(
  terminal: RuntimeTerminalSummary,
  lease: MaestroTerminalLease | null
): string {
  if (lease) {
    return lease.title
  }
  return stripBrailleSpinnerGlyphs(terminal.title ?? '') || 'Terminal'
}

function mergeTabGroups(
  session: RuntimeMobileSessionTabsResult,
  parentTabIds: readonly string[]
): RuntimeMobileSessionTabGroup[] {
  const fallbackGroupId = session.activeGroupId ?? session.tabGroups?.[0]?.id ?? 'maestro-runtime'
  const groups = (session.tabGroups ?? []).map((group) => ({
    ...group,
    tabOrder: [...group.tabOrder],
    ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
  }))
  const target = groups.find((group) => group.id === fallbackGroupId)
  const group =
    target ??
    ({
      id: fallbackGroupId,
      activeTabId: null,
      tabOrder: []
    } satisfies RuntimeMobileSessionTabGroup)
  if (!target) {
    groups.push(group)
  }
  const assigned = new Set(groups.flatMap((candidate) => candidate.tabOrder))
  for (const tabId of parentTabIds) {
    if (!assigned.has(tabId)) {
      group.tabOrder.push(tabId)
      assigned.add(tabId)
    }
  }
  return groups
}

export function mergeMaestroWorkspaceTerminalInventory(params: {
  scope: RuntimeMaestroWorkspaceCanvasScope
  session: RuntimeMobileSessionTabsResult
  terminalList: RuntimeTerminalListResult | null
  getLease: LeaseLookup
}): { session: RuntimeMobileSessionTabsResult; inventoryCursor: string } {
  const existingPaneKeys = new Set(
    params.session.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [`${tab.parentTabId}\0${tab.leafId}`] : []
    )
  )
  const inventoryTerminals = (params.terminalList?.terminals ?? [])
    .flatMap((terminal) => {
      if (!terminal.connected || !terminal.tabId || !terminal.leafId) {
        return []
      }
      const lease = matchingLease(params.scope, terminal, params.getLease)
      return [{ terminal, lease }]
    })
    .sort((left, right) =>
      `${left.terminal.tabId}\0${left.terminal.leafId}`.localeCompare(
        `${right.terminal.tabId}\0${right.terminal.leafId}`
      )
    )
  const cursorPayload = inventoryTerminals.map(({ terminal, lease }) => ({
    handle: terminal.handle,
    incarnationId: terminal.incarnationId ?? null,
    tabId: terminal.tabId,
    leafId: terminal.leafId,
    title: terminalProjectionTitle(terminal, lease),
    state: lease?.lifecycleState ?? null
  }))
  const inventoryCursor = createHash('sha256')
    .update(JSON.stringify(cursorPayload))
    .digest('hex')
    .slice(0, 24)
  const addedTabs = inventoryTerminals.flatMap(({ terminal, lease }) => {
    const paneKey = `${terminal.tabId}\0${terminal.leafId}`
    if (existingPaneKeys.has(paneKey)) {
      return []
    }
    existingPaneKeys.add(paneKey)
    return [
      {
        type: 'terminal' as const,
        id: `${terminal.tabId}::${terminal.leafId}`,
        parentTabId: terminal.tabId,
        leafId: terminal.leafId,
        ptyId: terminal.ptyId,
        status: 'ready' as const,
        terminal: terminal.handle,
        title: terminalProjectionTitle(terminal, lease),
        isActive: false
      }
    ]
  })
  if (addedTabs.length === 0) {
    return { session: params.session, inventoryCursor }
  }
  const parentTabIds = [...new Set(addedTabs.map((tab) => tab.parentTabId))]
  return {
    inventoryCursor,
    session: {
      ...params.session,
      tabGroups: mergeTabGroups(params.session, parentTabIds),
      tabs: [...params.session.tabs, ...addedTabs]
    }
  }
}
