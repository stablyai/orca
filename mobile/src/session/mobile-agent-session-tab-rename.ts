import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileSessionTab } from './mobile-session-route-types'

type AgentSessionTab = Extract<MobileSessionTab, { type: 'agent-session' }>

export type AgentSessionTabRenameOutcome =
  | { kind: 'renamed'; tabs: MobileSessionTab[] }
  | { kind: 'unsupported' }
  | { kind: 'failed' }

/** Whether this runtime cannot name a chat at all, as opposed to refusing this one. A host
 *  that predates the field still answers the method, so only these mean "no such surface". */
export function isAgentSessionRenameUnsupported(
  code: string | undefined,
  message: string | undefined
): boolean {
  return (
    code === 'forbidden' ||
    code === 'method_not_found' ||
    message?.includes('not available to mobile clients') === true
  )
}

/** Rename a structured chat on the host that owns it. An empty submission clears the name and
 *  the host republishes the placeholder, so it never publishes an empty label. */
export async function renameAgentSessionTab(args: {
  client: RpcClient
  worktreeId: string
  target: AgentSessionTab
  value: string
  tabs: readonly MobileSessionTab[]
}): Promise<AgentSessionTabRenameOutcome> {
  const title = args.value.trim() || null
  let response: RpcResponse
  try {
    response = await args.client.sendRequest('session.tabs.setTabProps', {
      worktree: `id:${args.worktreeId}`,
      tabId: args.target.id,
      title
    })
  } catch {
    return { kind: 'failed' }
  }
  if (!response.ok) {
    return isAgentSessionRenameUnsupported(response.error.code, response.error.message)
      ? { kind: 'unsupported' }
      : { kind: 'failed' }
  }
  return {
    kind: 'renamed',
    // The host republishes the resolved name; this only keeps the sheet from flashing the old one.
    tabs: args.tabs.map((tab) =>
      tab.id === args.target.id && tab.type === 'agent-session' && title ? { ...tab, title } : tab
    )
  }
}
