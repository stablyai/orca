import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
import { HANDLER_GROUPS, type HandlerGroup } from './handler-group-manifest'

export type HandlerContext = {
  flags: Map<string, string | boolean>
  client: RuntimeClient
  cwd: string
  json: boolean
  rawArgs?: string[]
}

export type CommandHandler = (ctx: HandlerContext) => Promise<void>

// Why: routing only needs key→group, so every CLI invocation can skip the
// transitive module graph of the 24 groups it does not dispatch into.
function buildRoutes(groups: readonly HandlerGroup[]): Map<string, HandlerGroup> {
  const table = new Map<string, HandlerGroup>()
  for (const group of groups) {
    for (const key of group.keys) {
      const owner = table.get(key)
      if (owner) {
        throw new Error(
          `Duplicate CLI handler registration for "${key}" (${owner.name} and ${group.name})`
        )
      }
      table.set(key, group)
    }
  }
  return table
}

const ROUTES = buildRoutes(HANDLER_GROUPS)

// Why: exposes only the canonical command keys (not the handler internals) so the
// registry-parity guard can check specs↔handlers without rebuilding the table.
export const HANDLER_COMMAND_KEYS: ReadonlySet<string> = new Set(ROUTES.keys())

export async function dispatch(commandPath: string[], ctx: HandlerContext): Promise<void> {
  const key = commandPath.join(' ')
  const group = ROUTES.get(key)
  if (!group) {
    throw new RuntimeClientError('invalid_argument', `Unknown command: ${key}`)
  }
  const handler = (await group.load())[key]
  // Why: the manifest key list is verified against the real exports in CI, so a
  // miss here means the group changed without the manifest — fail loudly.
  if (!handler) {
    throw new RuntimeClientError(
      'invalid_argument',
      `CLI handler group "${group.name}" does not export "${key}"`
    )
  }
  await handler(ctx)
}

export { buildRoutes as buildHandlerRoutes }
