// The servers approved plugins add, kept in the host's list as entries marked with their plugin, so
// Orca's sign-in, the relay and every launch treat them as any other server. The user's switches on
// one stay across plugin updates, and a sync that changes nothing writes nothing.
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { freeBotToolName, type BotToolServer } from '../../shared/bot-tools'
import type { BotToolNewCredential } from '../bots/bot-tools-file'
import { botToolsPath } from '../bots/bot-tools-path'
import { sortAddedBotTool } from '../bots/tool-oauth/bot-tool-owned-sign-in'
import { changeHostEntries, readHostEntries, type HostEntry } from './mcp-host-list'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { pluginMarkOf, type PluginMark } from './mcp-plugin-server-mark'

/** One server an approved plugin adds; `server.name` is the plugin's own name for it. */
export type PluginMcpServer = { pluginKey: string; pluginName: string; server: BotToolServer }

/**
 * What the host's plugins add now. `held`: plugins still installed and enabled whose update waits
 * for review; their entries stay as the user approved them, switches and sign-in included.
 */
export type PluginMcpServers = {
  declared: readonly PluginMcpServer[]
  held: ReadonlySet<string>
}

type Sorted = {
  server: BotToolServer
  signIn?: ReadonlyMap<string, BotToolNewCredential>
  unsorted: boolean
}

const keyOf = (pluginKey: string, server: string): string => JSON.stringify([pluginKey, server])
const itemKey = (item: PluginMcpServer): string => keyOf(item.pluginKey, item.server.name)

function markKey(entry: HostEntry): string | null {
  const mark = pluginMarkOf(entry.extras)
  return mark ? keyOf(mark.key, mark.server) : null
}

/** What the plugin decides: its address or command, never the list's name for it or Orca's sign-in. */
function definitionOf(server: BotToolServer): string {
  return JSON.stringify(
    'url' in server
      ? { url: server.url }
      : { command: server.command, args: server.args, env: server.env ?? {} }
  )
}

/** As add sorts an address: Orca signs in to one that asks for it. One it can't reach stays plain
 *  for now and is sorted again by the next sync. */
async function sortServer(server: BotToolServer, signal?: AbortSignal): Promise<Sorted> {
  const sorted = await sortAddedBotTool(server, signal)
  if ('failure' in sorted) {
    return { server, unsorted: sorted.failure === 'unavailable' }
  }
  return { ...sorted, unsorted: false }
}

function needsSorting(item: PluginMcpServer, current: HostEntry | undefined): boolean {
  return (
    'url' in item.server &&
    (!current ||
      definitionOf(current.server) !== definitionOf(item.server) ||
      pluginMarkOf(current.extras)?.unsorted === true)
  )
}

/** The server an entry for `item` holds: the current one while the plugin's definition holds and
 *  it's sorted, else the fresh sort, else the definition as declared. */
function settle(
  item: PluginMcpServer,
  current: HostEntry | undefined,
  sorted: Sorted | undefined
): Sorted {
  const same = current !== undefined && definitionOf(current.server) === definitionOf(item.server)
  const wasUnsorted = current ? pluginMarkOf(current.extras)?.unsorted === true : false
  if (same && !wasUnsorted) {
    return { server: current.server, unsorted: false }
  }
  // A sort of an older definition (the plugin changed meanwhile) doesn't fit this one.
  if (sorted && definitionOf(sorted.server) === definitionOf(item.server)) {
    return sorted
  }
  if (same) {
    return { server: current.server, unsorted: true }
  }
  return { server: item.server, unsorted: 'url' in item.server }
}

function nextEntries(
  entries: readonly HostEntry[],
  { declared, held }: PluginMcpServers,
  sorted: ReadonlyMap<string, Sorted>,
  credentials: Map<string, BotToolNewCredential>
): HostEntry[] {
  const wanted = new Map(declared.map((item) => [itemKey(item), item]))
  const present = new Set<string>()
  const entryFor = (item: PluginMcpServer, name: string, current?: HostEntry) => {
    const { server, signIn, unsorted } = settle(item, current, sorted.get(itemKey(item)))
    for (const [id, credential] of signIn ?? []) {
      if ('url' in server && server.credential === id) {
        credentials.set(id, credential)
      }
    }
    const plugin: PluginMark = {
      key: item.pluginKey,
      server: item.server.name,
      name: item.pluginName,
      ...(unsorted ? { unsorted: true as const } : {})
    }
    return { server: { ...server, name }, plugin }
  }
  const kept = entries.flatMap((entry): HostEntry[] => {
    const key = markKey(entry)
    if (key === null || held.has(pluginMarkOf(entry.extras)?.key ?? '')) {
      return [entry]
    }
    const item = wanted.get(key)
    if (!item || present.has(key)) {
      return []
    }
    present.add(key)
    const { server, plugin } = entryFor(item, entry.server.name, entry)
    // As an edit to a URL does: one process per agent is only for a command.
    const { sharedProcess: _dropped, ...urlExtras } = entry.extras
    const extras = 'url' in server ? urlExtras : entry.extras
    return [{ ...entry, server, extras: { ...extras, plugin } }]
  })
  const taken = new Set(kept.map((entry) => entry.server.name))
  const added = declared.flatMap((item): HostEntry[] => {
    if (present.has(itemKey(item))) {
      return []
    }
    const name = freeBotToolName(item.server.name, taken)
    taken.add(name)
    const id = randomUUID()
    const { server, plugin } = entryFor(item, name)
    return [{ server, extras: { id, plugin }, id }]
  })
  return [...kept, ...added]
}

const sameEntries = (a: readonly HostEntry[], b: readonly HostEntry[]): boolean =>
  a.length === b.length &&
  a.every(
    (entry, index) =>
      JSON.stringify([entry.server, entry.extras]) ===
      JSON.stringify([b[index].server, b[index].extras])
  )

/** Stands for "nothing to write", so the file and its revision stay as they are. */
class Unchanged extends Error {}

/** The list file's identity, so an edit by anything else (another process, a restore) shows. */
async function hostListFileStamp(folder: string): Promise<string> {
  const file = await stat(botToolsPath(folder), { bigint: true }).catch(() => null)
  return file ? `${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}` : 'absent'
}

/** What a sync of `plugins` into `folder` depends on, read before the sync: equal versions sync to
 *  the same entries. A sync's own write changes the stamp, so the next one checks once more. */
export async function pluginMcpServersVersion(
  plugins: PluginMcpServers,
  folder = mcpHostListFolder()
): Promise<string> {
  return JSON.stringify([
    folder,
    await hostListFileStamp(folder),
    plugins.declared,
    [...plugins.held].sort()
  ])
}

/** `settled`: the list matches `plugins` and every address is sorted, so the same plugins need no
 *  sync again. False when aborted or when an address couldn't be reached and waits for a retry. */
export type PluginMcpServerSyncResult = { wrote: boolean; settled: boolean }

/**
 * Makes the host's plugin entries match `plugins`: adds new ones, replaces a changed definition
 * (keeping the entry's id, name and switches), leaves held plugins' entries alone and removes the
 * rest; nothing once `signal` aborts before the write.
 */
export async function syncPluginMcpServers(
  plugins: PluginMcpServers,
  { signal }: { signal?: AbortSignal } = {},
  folder = mcpHostListFolder()
): Promise<PluginMcpServerSyncResult> {
  const { entries } = await readHostEntries(folder)
  const byKey = new Map(
    entries.flatMap((entry) => {
      const key = markKey(entry)
      return key ? [[key, entry] as const] : []
    })
  )
  // Sorting asks the address over the network, so it runs before the write, not inside it.
  const sorted = new Map(
    await Promise.all(
      plugins.declared
        .filter((item) => needsSorting(item, byKey.get(itemKey(item))))
        .map(async (item) => [itemKey(item), await sortServer(item.server, signal)] as const)
    )
  )
  // Filled by the change below and read by the write after it: the sign-ins its entries name.
  const credentials = new Map<string, BotToolNewCredential>()
  let settled = false
  try {
    await changeHostEntries(
      folder,
      (current) => {
        // A newer request replaces this snapshot (checked after the queue wait); its run writes instead.
        if (signal?.aborted) {
          throw new Unchanged()
        }
        credentials.clear()
        const next = nextEntries(current, plugins, sorted, credentials)
        settled = next.every((entry) => {
          const mark = pluginMarkOf(entry.extras)
          return !mark?.unsorted || plugins.held.has(mark.key)
        })
        if (sameEntries(current, next)) {
          throw new Unchanged()
        }
        return next
      },
      { credentials }
    )
  } catch (error) {
    if (error instanceof Unchanged) {
      return { wrote: false, settled }
    }
    throw error
  }
  return { wrote: true, settled }
}
