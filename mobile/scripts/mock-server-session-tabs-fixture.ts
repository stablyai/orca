import { randomUUID } from 'node:crypto'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

// Why: the client's snapshot-acceptance gate keys on the publisher epoch, so it
// must stay stable for the process and change on restart like a real publisher —
// hence a uuid, not a clock read two restarts could land on.
// The `mobile-local:` prefix is reserved for phone-local writes — never use it.
const PUBLICATION_EPOCH = `mock-server:${randomUUID()}`
const GROUP_ID = 'group-1'
const PARENT_TAB_ID = 'tab-1'
// The host only ever publishes terminal-layout UUIDs here; pane-key parsing
// rejects any other shape, so a placeholder would mask pane-attribution bugs.
const LEAF_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
// The host publishes terminal surfaces as `${parentTabId}::${leafId}`.
const SURFACE_TAB_ID = `${PARENT_TAB_ID}::${LEAF_ID}`

/** One ready terminal tab bound to the `term-1` fixture. Mirrors the full
 *  `session.tabs.list` contract so mock-server repros of tab, split-pane, and
 *  pane-attribution bugs aren't shape-incomplete. */
function createMockSessionTabs(worktreeId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: PUBLICATION_EPOCH,
    snapshotVersion: 1,
    activeGroupId: GROUP_ID,
    activeTabId: SURFACE_TAB_ID,
    activeTabType: 'terminal',
    // Groups track top-level tabs, so they carry parentTabId, not surface ids.
    tabGroups: [
      {
        id: GROUP_ID,
        activeTabId: PARENT_TAB_ID,
        tabOrder: [PARENT_TAB_ID],
        recentTabIds: [PARENT_TAB_ID]
      }
    ],
    tabs: [
      {
        type: 'terminal',
        id: SURFACE_TAB_ID,
        title: 'zsh',
        parentTabId: PARENT_TAB_ID,
        leafId: LEAF_ID,
        status: 'ready',
        terminal: 'term-1',
        isActive: true
      }
    ]
  }
}

/** Default session-tabs backend: without it the session screen hangs on
 *  'Loading tabs'. Returns false for methods it does not own. */
export function handleMockSessionTabsRequest(
  request: RpcRequest,
  respond: (response: RpcResponse) => void,
  success: (id: string, result: unknown, streaming?: boolean) => RpcResponse,
  // Shared with `terminal.list` so both surfaces agree on which worktree an
  // absent or `id:`-prefixed selector means.
  resolveWorktreeId: (selector: unknown) => string | undefined
): boolean {
  if (request.method === 'session.tabs.list') {
    const worktreeId = resolveWorktreeId(request.params?.worktree) ?? 'mock'
    respond(success(request.id, createMockSessionTabs(worktreeId)))
    return true
  }
  if (request.method === 'session.tabs.subscribe') {
    // Without a live stream the client's health loop keeps invalidating list
    // fetches mid-flight (barrier bump on the failed probe), so the session
    // screen never leaves 'Loading tabs'. snapshot then updated => 'live'.
    const worktreeId = resolveWorktreeId(request.params?.worktree) ?? 'mock'
    const snapshot = createMockSessionTabs(worktreeId)
    respond(success(request.id, { type: 'snapshot', ...snapshot }, true))
    respond(success(request.id, { type: 'updated', ...snapshot }, true))
    return true
  }
  if (request.method === 'session.tabs.unsubscribe') {
    respond(success(request.id, { unsubscribed: true }))
    return true
  }
  return false
}
