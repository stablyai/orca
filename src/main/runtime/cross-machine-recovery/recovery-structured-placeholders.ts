import type {
  RecoveryAgentBinding,
  RecoveryLayout,
  RecoveryTerminalLayout
} from '../../../shared/cross-machine-recovery-descriptor'

/** Source leaf id of a structured binding's placeholder pane; structured tabs have no leaves. */
export function structuredPlaceholderLeafId(binding: RecoveryAgentBinding): string | null {
  return binding.surface === 'structured' ? binding.sourceTabId : null
}

/**
 * Turns each agent-session tab a structured binding holds into a one-pane terminal tab in the
 * same slot, so the dormant session has a visible pane to resume into.
 */
export function withStructuredSessionPlaceholders(
  layout: RecoveryLayout,
  bindings: readonly RecoveryAgentBinding[]
): RecoveryLayout {
  const bound = new Set(
    bindings.flatMap((binding) => (binding.surface === 'structured' ? [binding.sourceTabId] : []))
  )
  const placeholders = layout.tabs.filter(
    (tab) => tab.contentType === 'agent-session' && bound.has(tab.id)
  )
  if (placeholders.length === 0) {
    return layout
  }
  const placeholderIds = new Set(placeholders.map((tab) => tab.id))
  const terminalLayouts: Record<string, RecoveryTerminalLayout> = { ...layout.terminalLayouts }
  for (const tab of placeholders) {
    terminalLayouts[tab.id] = {
      root: { type: 'leaf', leafId: tab.id },
      activeLeafId: tab.id,
      expandedLeafId: null
    }
  }
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => {
      if (!placeholderIds.has(tab.id)) {
        return tab
      }
      const { agentSessionAgent: _agent, ...rest } = tab
      return { ...rest, contentType: 'terminal', entityId: tab.id }
    }),
    terminalTabs: [
      ...layout.terminalTabs,
      ...placeholders.map((tab) => ({
        id: tab.id,
        title: tab.label,
        customTitle: tab.customLabel,
        color: tab.color,
        sortOrder: tab.sortOrder,
        createdAt: tab.createdAt
      }))
    ],
    terminalLayouts,
    activeTabType:
      layout.activeTabId !== null && placeholderIds.has(layout.activeTabId)
        ? 'terminal'
        : layout.activeTabType
  }
}
