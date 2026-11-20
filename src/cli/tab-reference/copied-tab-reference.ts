import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../shared/agent-session/identity/orca-session-address-prefix'
import type { BrowserTabListResult } from '../../shared/browser/runtime/runtime-browser-contracts'

// Copy Tab ID copies the workspace tab id (`orcaTabId`), but `--page` takes a browser page id and
// `--terminal`/`--to` a terminal handle; without this mapping agents fall back to guessing the tab.

type InventoryTab =
  | {
      type: 'terminal'
      id: string
      parentTabId?: string
      leafId?: string
      terminal?: string | null
    }
  | { type: string; id: string }

export type SessionTabsInventory = {
  snapshots: { worktree: string; tabs: InventoryTab[] }[]
}

const TAB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COPIED_LABEL_RE = /^orcaTabId:\s*/i

/** A pasted `orcaTabId: <id>` line or padded id reads as the bare, lower-case tab id. */
function copiedTabId(value: string): string | null {
  const id = value.trim().replace(COPIED_LABEL_RE, '')
  return TAB_ID_RE.test(id) ? id.toLowerCase() : null
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

// Copy Tab ID gives a chat `structured-agent-session-<sessionId>`; the inventory lists `agent-session:<sessionId>`.
const CHAT_TAB_PREFIXES = ['structured-agent-session-', 'agent-session:']

/** The chat session a copied chat tab id names, read from the id itself; null for anything else. */
export function chatSessionForTabId(value: string): string | null {
  const id = value.trim().replace(COPIED_LABEL_RE, '')
  const prefix = CHAT_TAB_PREFIXES.find((candidate) => id.startsWith(candidate))
  return prefix ? id.slice(prefix.length) || null : null
}

/** Maps a copied chat or terminal tab id given as a message recipient; `remote` hosts own their tabs. */
export async function resolveRecipientReference(
  client: RuntimeClient,
  to: string,
  options: { remote?: boolean } = {}
): Promise<string> {
  const chatSession = chatSessionForTabId(to)
  if (chatSession) {
    return `${ORCA_SESSION_ADDRESS_PREFIX}${chatSession}`
  }
  return options.remote ? to : resolveTerminalReference(client, to, '--to')
}

/** Only an older host's missing method passes the value through; other failures surface as they are. */
async function callUnlessMissing<T>(client: RuntimeClient, method: string, params: unknown) {
  try {
    return (await client.call<T>(method, params)).result
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return null
    }
    throw error
  }
}

/** Maps a copied browser tab id to the page it shows; page ids and other values are returned unchanged. */
export async function resolveBrowserPageReference(
  client: RuntimeClient,
  page: string
): Promise<string> {
  const tabId = copiedTabId(page)
  if (!tabId) {
    return page
  }
  // A read-only page listing, not the session inventory, since page ids look like tab ids too.
  const listing = await callUnlessMissing<BrowserTabListResult>(client, 'browser.tabList', {})
  const tabs = listing?.tabs ?? []
  if (tabs.some((tab) => tab.browserPageId === tabId)) {
    return tabId
  }
  return tabs.find((tab) => tab.unifiedTabId === tabId)?.browserPageId ?? page
}

/** Maps a copied terminal tab id to its terminal handle; handles and other values pass through. */
export async function resolveTerminalReference(
  client: RuntimeClient,
  terminal: string,
  /** The flag the caller read the value from, so recovery steps name the flag to retry with. */
  flag: '--terminal' | '--to' = '--terminal'
): Promise<string> {
  const tabId = copiedTabId(terminal)
  if (!tabId) {
    return terminal
  }
  const inventory = await callUnlessMissing<SessionTabsInventory>(
    client,
    'session.tabs.listAll',
    null
  )
  const panes =
    inventory && Array.isArray(inventory.snapshots) ? findTerminalsForTabId(inventory, tabId) : []
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
      `Tab ${tabId} has no running terminal yet.`,
      { nextSteps: ['Open the tab in Orca, then retry.'] }
    )
  }
  // A split tab holds several terminals; picking one would act on a pane the user did not mean.
  throw new RuntimeClientError(
    'invalid_argument',
    `Tab ${tabId} holds ${panes.length} terminals. Pass one of their handles as ${flag}.`,
    { nextSteps: handles.map((handle) => `${flag} ${handle}`) }
  )
}
