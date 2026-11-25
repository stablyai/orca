// Which of the host list's command servers Orca runs once on the host for every session, read
// without writing: a launch points its agent at them, the relay starts them.
import type { BotToolServer } from '../../shared/bot-tools'
import { botToolEntries, readBotToolsSnapshot } from '../bots/bot-tools-file'
import type { BotToolEntry } from '../bots/bot-tool-entry-extras'
import { mcpHostListFolder } from './mcp-host-list-folder'

/** A host list entry's id; also what names a shared server on the relay. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/** A command server, as the host list keeps it. */
export type McpCommandServer = Extract<BotToolServer, { command: string }>

/** A launch's servers, and which of them are command servers Orca runs once, by name to their id. */
export type McpLaunchServers = {
  servers: BotToolServer[]
  sharedProcesses: ReadonlyMap<string, string>
}

const sharedId = ({ server, extras }: BotToolEntry): string | null =>
  !('url' in server) &&
  extras.sharedProcess === true &&
  typeof extras.id === 'string' &&
  ID_PATTERN.test(extras.id)
    ? extras.id
    : null

const entriesOf = async (folder: string): Promise<BotToolEntry[]> =>
  botToolEntries(await readBotToolsSnapshot(folder))

/**
 * The shared command servers in the whole list `entries`, by name to their id. An id two entries
 * hold (an edit outside Orca) names neither, so no lookup can run one entry's command for the other.
 */
export function sharedIds(entries: readonly BotToolEntry[]): Map<string, string> {
  const holders = new Map<unknown, number>()
  for (const { extras } of entries) {
    holders.set(extras.id, (holders.get(extras.id) ?? 0) + 1)
  }
  const ids = new Map<string, string>()
  for (const entry of entries) {
    const id = sharedId(entry)
    if (id && holders.get(id) === 1) {
      ids.set(entry.server.name, id)
    }
  }
  return ids
}

/** The host list's shared command servers, by name to their id. */
export async function sharedMcpProcessIds(folder: string): Promise<Map<string, string>> {
  return sharedIds(await entriesOf(folder))
}

/** The command server with `id` while it's set to share one process; null otherwise. */
export async function sharedMcpProcessServer(
  id: string,
  folder = mcpHostListFolder()
): Promise<McpCommandServer | null> {
  const entries = await entriesOf(folder)
  const name = [...sharedIds(entries)].find(([, shared]) => shared === id)?.[0]
  const entry = entries.find(({ server }) => server.name === name)
  return entry && !('url' in entry.server) ? entry.server : null
}
