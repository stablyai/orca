import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'

/** Existing callers may name a terminal entity; the repository addresses its stable host tab. */
export function normalizeSurfaceLayoutCommand(
  input: LayoutCommand,
  surfaces: readonly WorkspaceSurface[]
): LayoutCommand {
  const tabIdOf = (id: string): string =>
    surfaces.find(
      (surface) =>
        surface.workspaceId === input.workspace &&
        (surface.hostTabId === id ||
          (surface.content?.kind === 'terminal' && surface.content.entityId === id))
    )?.hostTabId ?? id
  if (input.type === 'closeTabs') {
    return { ...input, tabIds: input.tabIds.map(tabIdOf) }
  }
  if (input.type === 'moveTabToWorkspace') {
    return { ...input, tabs: input.tabs.map((tab) => ({ ...tab, tabId: tabIdOf(tab.tabId) })) }
  }
  return 'tabId' in input && input.tabId && input.type !== 'createTerminalTab'
    ? { ...input, tabId: tabIdOf(input.tabId) }
    : input
}
