// The mark on a host-list entry that a plugin added; the plugin's sync owns every marked entry.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type { McpServer } from '../../shared/mcp-servers/mcp-servers'
import { McpServersError } from './mcp-servers-error'

/** Which plugin added an entry, under which of its server names; `unsorted` asks the next sync to
 *  learn again whether Orca signs in to it, after a check that couldn't reach the address. */
const PluginMarkSchema = lazyZodSchema(() =>
  z.object({
    key: z.string(),
    server: z.string(),
    name: z.string(),
    unsorted: z.literal(true).optional()
  })
)
export type PluginMark = z.infer<typeof PluginMarkSchema>

export const pluginMarkOf = (extras: Record<string, unknown>): PluginMark | null =>
  PluginMarkSchema.safeParse(extras.plugin).data ?? null

/** The row's `plugin`, on a plugin's entry only. */
export function pluginViewOf(extras: Record<string, unknown>): Pick<McpServer, 'plugin'> {
  const mark = pluginMarkOf(extras)
  return mark ? { plugin: { key: mark.key, name: mark.name } } : {}
}

/** Refuses an edit or removal of a plugin's entry: only its switches change in the list. */
export function assertNotFromPlugin(extras: Record<string, unknown>): void {
  const mark = pluginMarkOf(extras)
  if (mark) {
    throw new McpServersError(
      'mcp_server_from_plugin',
      `${mark.name} adds this server, so only its agents and workspaces change here.`
    )
  }
}
