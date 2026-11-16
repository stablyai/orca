import { randomUUID } from 'node:crypto'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type {
  WorktreeTerminalProvisioningHost,
  TerminalSurfacing
} from './runtime-worktree-terminal-provisioning'

export async function createWorktreeDefaultTabTerminals(
  host: WorktreeTerminalProvisioningHost,
  selector: string,
  worktreeId: string,
  defaultTabs: CreateWorktreeResult['defaultTabs'] | undefined,
  surfacing: TerminalSurfacing = {},
  startupHandle?: string
): Promise<string[]> {
  if (!defaultTabs || defaultTabs.tabs.length === 0 || !host.canSpawn()) {
    return []
  }
  const [first, ...rest] = defaultTabs.tabs
  // Startup occupies the first default tab: inherit its title/color without also running its template command.
  if (startupHandle && first) {
    await dressAsDefaultTab(host, worktreeId, startupHandle, first)
  }
  if (ORCA_LAYOUT_OWNER_IS_MAIN && host.applyDefaultTabs) {
    return startDefaultTabsInLayout(
      host,
      host.applyDefaultTabs,
      { selector, worktreeId, defaultTabs, surfacing },
      startupHandle ? rest : defaultTabs.tabs
    )
  }
  const handles: string[] = []
  for (const template of startupHandle ? rest : defaultTabs.tabs) {
    try {
      const command = template.command?.trim()
      const terminal = await host.createTerminal(selector, {
        ...(template.title ? { title: template.title } : {}),
        ...(command && defaultTabs.runCommands ? { command } : {}),
        ...surfacing
      })
      handles.push(terminal.handle)
      await dressAsDefaultTab(host, worktreeId, terminal.handle, template)
    } catch (error) {
      console.warn(`[worktree-create] Failed to create default tab for ${worktreeId}:`, error)
    }
  }
  return handles
}

async function startDefaultTabsInLayout(
  host: WorktreeTerminalProvisioningHost,
  applyDefaultTabs: NonNullable<WorktreeTerminalProvisioningHost['applyDefaultTabs']>,
  {
    selector,
    worktreeId,
    defaultTabs,
    surfacing
  }: {
    selector: string
    worktreeId: string
    defaultTabs: NonNullable<CreateWorktreeResult['defaultTabs']>
    surfacing: TerminalSurfacing
  },
  templates: NonNullable<CreateWorktreeResult['defaultTabs']>['tabs']
): Promise<string[]> {
  const panes = templates.map((template) => ({
    template,
    tab: {
      tabId: randomUUID(),
      leafId: randomUUID(),
      ...(template.title ? { title: template.title } : {}),
      ...(template.color ? { color: template.color } : {})
    }
  }))
  const createdTabs = await applyDefaultTabs(
    worktreeId,
    panes.map(({ tab }) => tab)
  )
  if (!createdTabs) {
    console.warn(`[worktree-create] Main refused the default tabs for ${worktreeId}`)
    return []
  }
  // Start only newly created defaults; existing workspaces receive none again.
  const created = new Set(createdTabs.map(({ tabId }) => tabId))
  const handles: string[] = []
  for (const { template, tab } of panes.filter(({ tab }) => created.has(tab.tabId))) {
    const command = template.command?.trim()
    try {
      const terminal = await host.createTerminal(selector, {
        tabId: tab.tabId,
        leafId: tab.leafId,
        ...(template.title ? { title: template.title } : {}),
        ...(command && defaultTabs.runCommands ? { command } : {}),
        ...surfacing
      })
      handles.push(terminal.handle)
    } catch (error) {
      console.warn(`[worktree-create] Failed to start a default tab for ${worktreeId}:`, error)
    }
  }
  return handles
}

// Appearance failures must not cost the tab, the other field or workspace creation.
async function dressAsDefaultTab(
  host: WorktreeTerminalProvisioningHost,
  worktreeId: string,
  handle: string,
  template: NonNullable<CreateWorktreeResult['defaultTabs']>['tabs'][number]
): Promise<void> {
  if (template.title) {
    try {
      await host.setTabTitle(handle, template.title)
    } catch (error) {
      console.warn(`[worktree-create] Failed to title a default tab for ${worktreeId}:`, error)
    }
  }
  if (template.color) {
    try {
      await host.setTabColor(handle, template.color)
    } catch (error) {
      console.warn(`[worktree-create] Failed to color a default tab for ${worktreeId}:`, error)
    }
  }
}
