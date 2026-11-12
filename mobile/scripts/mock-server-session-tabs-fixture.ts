import { randomUUID } from 'node:crypto'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'

// Publisher epoch must be stable until restart and change on restart: use UUID, not clock. Never use reserved phone-local mobile-local: prefix.
const PUBLICATION_EPOCH = `mock-server:${randomUUID()}`
const GROUP_ID = 'group-1'
const PARENT_TAB_ID = 'tab-1'
// Use terminal-layout UUIDs: pane-key parser rejects placeholders, which would mask attribution bugs.
const LEAF_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
// The host publishes terminal surfaces as `${parentTabId}::${leafId}`.
const SURFACE_TAB_ID = `${PARENT_TAB_ID}::${LEAF_ID}`

// Complete session.tabs.list fixture for term-1 so tab/split/pane repros do not pass against incomplete contract shapes.
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

// Provide session.tabs.list or screen hangs on Loading tabs; return false for unowned methods.
export function handleMockSessionTabsRequest(
  request: RpcRequest,
  respond: (response: RpcResponse) => void,
  success: (id: string, result: unknown, streaming?: boolean) => RpcResponse,
  // Share selector resolution with terminal.list so absent/id:-prefixed selectors name same worktree.
  resolveWorktreeId: (selector: unknown) => string | undefined
): boolean {
  if (request.method === 'session.tabs.list') {
    const worktreeId = resolveWorktreeId(request.params?.worktree) ?? 'mock'
    respond(success(request.id, createMockSessionTabs(worktreeId)))
    return true
  }
  if (request.method === 'session.tabs.subscribe') {
    // Emit snapshot→updated to reach live; otherwise failed health probes invalidate list fetches mid-flight and leave Loading tabs.
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
