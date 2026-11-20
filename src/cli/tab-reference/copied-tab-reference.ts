import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

// Why: Copy Tab ID copies the workspace tab id (`orcaTabId`), but `--page` takes a browser page id
// and `--terminal` a terminal handle. Agents handed a copied id would otherwise get "not found" and
// fall back to guessing the tab by title or URL. The session tab inventory links both.

type InventoryTab =
  | { type: 'browser'; id: string; browserPageId?: string | null }
  | {
      type: 'terminal'
      id: string
      parentTabId?: string
      leafId?: string
      terminal?: string | null
    }
  | { type: 'agent-session'; id: string; sessionId?: string }
  | { type: string; id: string }

export type SessionTabsInventory = {
  snapshots: { worktree: string; tabs: InventoryTab[] }[]
}

// Workspace tab ids are UUIDs; anything else (handles, group names, selectors) skips the lookup.
const TAB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function findBrowserPageForTabId(
  inventory: SessionTabsInventory,
  tabId: string
): string | null {
  for (const snapshot of inventory.snapshots) {
    for (const tab of snapshot.tabs) {
      if (tab.type === 'browser' && tab.id === tabId && 'browserPageId' in tab) {
        return tab.browserPageId ?? null
      }
    }
  }
  return null
}

export function findTerminalsForTabId(
  inventory: SessionTabsInventory,
  tabId: string
): { leafId: string; handle: string | null }[] {
  const found: { leafId: string; handle: string | null }[] = []
  for (const snapshot of inventory.snapshots) {
    for (const tab of snapshot.tabs) {
      if (tab.type === 'terminal' && 'parentTabId' in tab && tab.parentTabId === tabId) {
        found.push({ leafId: tab.leafId ?? tab.id, handle: tab.terminal ?? null })
      }
    }
  }
  return found
}

// Copy Tab ID gives a chat `structured-agent-session-<sessionId>` (or a minted `chat-tab-…` slot id);
// the tab inventory lists the same chat as `agent-session:<sessionId>`.
const SESSION_NAMING_CHAT_TAB_PREFIXES = ['structured-agent-session-', 'agent-session:']
const CHAT_TAB_PREFIXES = [...SESSION_NAMING_CHAT_TAB_PREFIXES, 'chat-tab-']

export function findChatSessionForTabId(
  inventory: SessionTabsInventory | null,
  tabId: string
): string | null {
  for (const snapshot of inventory?.snapshots ?? []) {
    for (const tab of snapshot.tabs) {
      if (tab.type === 'agent-session' && tab.id === tabId && 'sessionId' in tab) {
        return tab.sessionId ?? null
      }
    }
  }
  // These forms name their session even when the tab is closed or the host lists no chats.
  const prefix = SESSION_NAMING_CHAT_TAB_PREFIXES.find((candidate) => tabId.startsWith(candidate))
  return prefix ? tabId.slice(prefix.length) || null : null
}

/** Maps a copied chat tab id to the chat's Orca session id; any other value is returned as null. */
export async function resolveChatSessionReference(
  client: RuntimeClient,
  value: string
): Promise<string | null> {
  if (!CHAT_TAB_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return null
  }
  return findChatSessionForTabId(await readInventory(client), value)
}

async function readInventory(client: RuntimeClient): Promise<SessionTabsInventory | null> {
  try {
    const response = await client.call<SessionTabsInventory>('session.tabs.listAll', null)
    return Array.isArray(response.result?.snapshots) ? response.result : null
  } catch {
    // Older hosts without the inventory keep the value as given; the command reports its own error.
    return null
  }
}

/** Maps a copied browser tab id to the page it shows; any other value is returned unchanged. */
export async function resolveBrowserPageReference(
  client: RuntimeClient,
  page: string
): Promise<string> {
  if (!TAB_ID_RE.test(page)) {
    return page
  }
  const inventory = await readInventory(client)
  return (inventory && findBrowserPageForTabId(inventory, page)) ?? page
}

/** Maps a copied terminal tab id to its terminal handle; handles and other values pass through. */
export async function resolveTerminalReference(
  client: RuntimeClient,
  terminal: string,
  /** The flag the caller read the value from, so recovery steps name the flag to retry with. */
  flag: '--terminal' | '--to' = '--terminal'
): Promise<string> {
  if (!TAB_ID_RE.test(terminal)) {
    return terminal
  }
  const inventory = await readInventory(client)
  const panes = inventory ? findTerminalsForTabId(inventory, terminal) : []
  if (panes.length === 0) {
    return terminal
  }
  const handles = panes.flatMap((pane) => (pane.handle ? [pane.handle] : []))
  if (panes.length === 1 && handles.length === 1) {
    return handles[0]
  }
  if (handles.length === 0) {
    throw new RuntimeClientError(
      'terminal_not_ready',
      `Tab ${terminal} has no running terminal yet. Nothing was sent.`,
      { nextSteps: ['Open the tab in Orca, then retry.'] }
    )
  }
  // A split tab holds several terminals; picking one would act on a pane the user did not mean.
  throw new RuntimeClientError(
    'invalid_argument',
    `Tab ${terminal} holds ${panes.length} terminals. Pass one of their handles as ${flag}. Nothing was sent.`,
    { nextSteps: handles.map((handle) => `${flag} ${handle}`) }
  )
}
