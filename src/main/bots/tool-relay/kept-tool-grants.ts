// Where kept relay grants and shared-tool callers live, and their restore at startup: the grants open
// (and every daemon start's front is served) before the callers, whose owners must still be kept.
// Light on purpose: the relay itself loads only when a grants file exists or a chat launches.
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bot } from '../../../shared/bot-types'
import { botHomeFolder } from '../bot-home'
import { mcpHostListFolder } from '../../mcp-servers/mcp-host-list-folder'
import { MCP_HOST_LIST_RELAY_OWNER, type RelayFolders } from './bot-tool-relay-grants'

export type KeptToolGrantsConfig = {
  /** Orca's app data folder. */
  directory: string
  /** The current bots; null while they can't be read (the file's folders are kept then). */
  bots: () => readonly Pick<Bot, 'id' | 'folder' | 'hostMcpServers'>[] | null
}

let config: KeptToolGrantsConfig | null = null
let currentRun: ((sessionId: string) => number | null) | null = null
let restoring: Promise<void> | null = null

export const keptToolGrantsPath = (directory: string): string =>
  join(directory, 'bot-tool-relay-grants.json')
export const keptToolCallersPath = (directory: string): string =>
  join(directory, 'shared-tool-callers.json')

/** Desktop startup on macOS and Linux, where agents can outlive the app; elsewhere nothing is kept. */
export function configureKeptToolGrants(installed: KeptToolGrantsConfig): void {
  config = installed
  startRestore()
}

/** The chat host: the fence of the run each chat's current placement names (relayed runs only). */
export function installKeptToolCallerRuns(lookup: (sessionId: string) => number | null): void {
  currentRun = lookup
  startRestore()
}

export function keptToolGrantsConfig(): KeptToolGrantsConfig | null {
  return config
}

export function keptToolCallerRunsInstalled(): boolean {
  return currentRun !== null
}

export function keptToolCallerRun(sessionId: string): number | null {
  return currentRun?.(sessionId) ?? null
}

/** Each owner's reach from the current config; null for a bot that no longer exists. */
export function keptGrantOwnerFolders(
  installed: KeptToolGrantsConfig
): ((owner: string) => RelayFolders | null) | undefined {
  const bots = installed.bots()
  if (!bots) {
    return undefined
  }
  return (owner) => {
    if (owner === MCP_HOST_LIST_RELAY_OWNER) {
      return { host: mcpHostListFolder() }
    }
    const bot = bots.find((entry) => entry.id === owner)
    if (!bot) {
      return null
    }
    return {
      bot: botHomeFolder(bot),
      ...(bot.hostMcpServers ? { host: mcpHostListFolder() } : {})
    }
  }
}

function startRestore(): void {
  if (!config || !currentRun || restoring) {
    return
  }
  const directory = config.directory
  restoring = restore(directory).catch((error: unknown) =>
    console.warn('[bot-tool-relay] kept tool grants could not be restored', error)
  )
}

async function restore(directory: string): Promise<void> {
  try {
    await access(keptToolGrantsPath(directory))
  } catch {
    // Nothing was kept, so no agent from an earlier run holds a front or a kept token.
    return
  }
  // Grants open and fronts are served first; callers need their owners' grants.
  const [{ botToolRelay }, callers, store] = await Promise.all([
    import('./bot-tool-relay'),
    import('../../runtime/agent-session/environment/shared-tool-process-callers'),
    import('../../runtime/agent-session/environment/shared-tool-caller-store')
  ])
  await botToolRelay.kept.serveFronts()
  callers.restoreKeptSharedToolCallers(await store.sharedToolCallerStore.load())
}
