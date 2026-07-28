import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

// Why: the client's snapshot-acceptance gate keys on the publisher epoch, so it
// must stay stable for the process and change on restart like a real publisher.
// The `mobile-local:` prefix is reserved for phone-local writes — never use it.
const PUBLICATION_EPOCH = `mock-server:${Date.now().toString(36)}`
const GROUP_ID = 'group-1'
const PARENT_TAB_ID = 'tab-1'
// The host only ever publishes terminal-layout UUIDs here; pane-key parsing
// rejects any other shape, so a placeholder would mask pane-attribution bugs.
const LEAF_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
// Surface ids are `${parentTabId}::${leafId}`, matching mobileTerminalSurfaceId.
const SURFACE_TAB_ID = `${PARENT_TAB_ID}::${LEAF_ID}`

function worktreeIdOf(selector: unknown): string {
  if (typeof selector !== 'string') {
    return 'mock'
  }
  return selector.startsWith('id:') ? selector.slice(3) : selector
}

/** One ready terminal tab bound to the `term-1` fixture. Mirrors the full
 *  `session.tabs.list` contract so mock-server repros of tab, split-pane, and
 *  pane-attribution bugs aren't shape-incomplete. */
function createMockSessionTabs(worktree: unknown): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeIdOf(worktree),
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
  success: (id: string, result: unknown, streaming?: boolean) => RpcResponse
): boolean {
  if (request.method !== 'session.tabs.list') {
    return false
  }
  respond(success(request.id, createMockSessionTabs(request.params?.worktree)))
  return true
}
