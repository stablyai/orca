import { z } from 'zod'

export type MobileDesktopTabTitle = {
  title: string | null
  tabId: string
  leafId: string
  agentIdentity?: string
}

const inventorySchema = z.object({ terminals: z.array(z.unknown()), visualLayouts: z.unknown() })
const terminalSchema = z.object({
  handle: z.string(),
  tabId: z.string(),
  leafId: z.string(),
  agentIdentity: z.string().optional()
})
const layoutSchema = z.object({ worktreeId: z.string(), root: z.unknown() })
const tabSchema = z.object({ tabId: z.string(), title: z.string().nullable(), panes: z.unknown() })
const nodeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('group'), tabs: z.array(z.unknown()) }),
  z.object({
    type: z.enum(['split', 'pane-split']),
    first: z.unknown(),
    second: z.unknown()
  }),
  terminalSchema.extend({ type: z.literal('terminal') })
])

// Why: session.tabs carries the pane's live OSC title (or a user's rename), while the desktop tab
// strip shows its own resolved name, generated task names included. Only the inventory's layouts
// carry that name to the phone.
export function readMobileDesktopTabTitles(
  inventory: unknown,
  worktreeId: string
): ReadonlyMap<string, MobileDesktopTabTitle> {
  const titles = new Map<string, MobileDesktopTabTitle>()
  const parsed = inventorySchema.safeParse(inventory)
  if (!parsed.success || !Array.isArray(parsed.data.visualLayouts)) {
    return titles
  }
  const terminals = new Map(
    parsed.data.terminals.flatMap((row) => {
      const terminal = terminalSchema.safeParse(row)
      return terminal.success ? [[terminal.data.handle, terminal.data] as const] : []
    })
  )
  for (const rawLayout of parsed.data.visualLayouts) {
    const layout = layoutSchema.safeParse(rawLayout)
    if (!layout.success || layout.data.worktreeId !== worktreeId) {
      continue
    }
    const pending: { node: unknown; tab?: z.infer<typeof tabSchema> }[] = [
      { node: layout.data.root }
    ]
    while (pending.length > 0) {
      const entry = pending.pop()!
      const parsedNode = nodeSchema.safeParse(entry.node)
      if (!parsedNode.success) {
        continue
      }
      const node = parsedNode.data
      if (node.type === 'group') {
        for (const rawTab of node.tabs) {
          const tab = tabSchema.safeParse(rawTab)
          if (tab.success) {
            pending.push({ node: tab.data.panes, tab: tab.data })
          }
        }
      } else if (node.type === 'split' || node.type === 'pane-split') {
        pending.push({ node: node.first, tab: entry.tab }, { node: node.second, tab: entry.tab })
      } else if (node.type === 'terminal') {
        const terminal = terminals.get(node.handle)
        if (
          entry.tab &&
          terminal &&
          entry.tab.tabId === node.tabId &&
          terminal.tabId === node.tabId &&
          terminal.leafId === node.leafId
        ) {
          titles.set(node.handle, {
            title: entry.tab.title?.trim() || null,
            tabId: node.tabId,
            leafId: node.leafId,
            agentIdentity: terminal.agentIdentity
          })
        }
      }
    }
  }
  return titles
}

export function mobileDesktopTabTitlesEqual(
  left: ReadonlyMap<string, MobileDesktopTabTitle>,
  right: ReadonlyMap<string, MobileDesktopTabTitle>
): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const [handle, title] of left) {
    const other = right.get(handle)
    if (
      !other ||
      title.title !== other.title ||
      title.tabId !== other.tabId ||
      title.leafId !== other.leafId ||
      title.agentIdentity !== other.agentIdentity
    ) {
      return false
    }
  }
  return true
}
