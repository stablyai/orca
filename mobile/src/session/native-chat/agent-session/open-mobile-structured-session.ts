import type { BotLinkOpenTarget } from '../../../../../src/shared/bots/bot-link-open-target'
import {
  openStructuredAgentSession,
  structuredSessionOpenFailure,
  type StructuredSessionOpenSource,
  type StructuredSessionOpenTab,
  type StructuredSessionOpenTarget
} from '../../../../../src/shared/agent-session/view/open-structured-agent-session'
import { isStructuredAgentId } from '../../../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { structuredAgentSessionPaneKey } from '../../../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  structuredOpenLocation,
  structuredOpenParty,
  structuredOpenReveal,
  structuredOpenTabs
} from './mobile-structured-session-open-rpc'
import { sessionTabActivate } from '../../tabs/mobile-session-tab-write-operations'
import { readWhileBotLinkConnected } from '../../../bots/bot-link-connection-read'
import type { SendRequestOptions } from '../../../transport/rpc/unvalidated-rpc-request-port'

/** The workspace client already carries executionHost; a single budget includes connect waits. */
export async function openMobileStructuredSession(args: {
  botLinkTarget?: BotLinkOpenTarget
  client: RpcClient
  source: StructuredSessionOpenSource
  current: () => boolean
  signal?: AbortSignal
  inventory?: { worktreeId: string; tabs: readonly StructuredSessionOpenTab[] }
}) {
  const agent = args.source.kind === 'sender' ? args.source.fallback?.agent : args.source.agent
  if (agent && !isStructuredAgentId(agent)) {
    return {
      kind: 'failed',
      failure: { reason: 'unsupported', beforeEffects: true }
    } as const
  }
  const deadline = Date.now() + 15_000
  const generation = args.client.getGeneration?.()
  const current = () =>
    !args.signal?.aborted &&
    args.current() &&
    args.client.getState() === 'connected' &&
    args.client.getGeneration?.() === generation &&
    Date.now() < deadline
  const stage = async <T>(request: (options: SendRequestOptions) => Promise<T>): Promise<T> => {
    if (!current()) {
      throw new Error('Opening no longer belongs to this view')
    }
    const timeoutMs = Math.min(5_000, deadline - Date.now())
    const reply = await readWhileBotLinkConnected(
      args.client,
      (signal) =>
        request({
          signal,
          timeoutMs,
          budgetSpansConnect: true,
          failWhenDisconnected: true,
          beforeSend: () => {
            if (!current() || signal.aborted) {
              throw new Error('Opening cancelled')
            }
          }
        }),
      { signal: args.signal, timeoutMs }
    )
    if (!current()) {
      throw new Error('Opening cancelled')
    }
    return reply
  }
  const tabs = new Map<string, readonly StructuredSessionOpenTab[]>(
    args.inventory ? [[args.inventory.worktreeId, args.inventory.tabs]] : []
  )
  const party = async (
    operation: typeof structuredOpenLocation | typeof structuredOpenParty,
    address: string,
    messageIds: readonly string[]
  ) => {
    const reply = await stage((options) =>
      operation.request(
        args.client,
        { address, ...(messageIds.length ? { messageIds: [...messageIds] } : {}) },
        options
      )
    )
    if (!reply.ok) {
      return structuredSessionOpenFailure(reply.error)
    }
    const found = operation.interpret(reply)
    if (
      args.botLinkTarget &&
      (found.location?.kind !== 'chat' ||
        found.location.sessionId !== args.botLinkTarget.sessionId ||
        found.location.worktreeId !== args.botLinkTarget.worktreeId)
    ) {
      return { reason: 'gone', beforeEffects: true } as const
    }
    return found
  }
  return openStructuredAgentSession(args.source, {
    current,
    locate: (address, messageIds) => party(structuredOpenLocation, address, messageIds),
    open: (address, messageIds) => party(structuredOpenParty, address, messageIds),
    tabs: (target) => tabs.get(target.worktreeId) ?? [],
    refresh: async (target) => {
      const reply = await stage((options) =>
        structuredOpenTabs.request(args.client, { worktree: `id:${target.worktreeId}` }, options)
      )
      if (!reply.ok) {
        throw Object.assign(new Error('Inventory refused'), reply.error)
      }
      const rows = structuredOpenTabs
        .interpret(reply)
        .tabs.flatMap((tab) =>
          tab.type === 'agent-session' && tab.sessionId
            ? [{ id: tab.id, sessionId: tab.sessionId, agent: tab.agent }]
            : []
        )
      tabs.set(target.worktreeId, rows)
    },
    activate: async (tab, target) => {
      if (!isStructuredAgentId(tab.agent)) {
        throw Object.assign(new Error('Chat cannot render'), {
          code: 'structured_agent_session_unsupported'
        })
      }
      const reply = await stage((options) =>
        sessionTabActivate.request(
          args.client,
          {
            worktree: `id:${target.worktreeId}`,
            tabId: tab.id,
            navigation: 'caller',
            notifyClients: false,
            intent: 'user',
            ...(args.botLinkTarget ? { botLinkTarget: args.botLinkTarget } : {})
          },
          options
        )
      )
      if (!reply.ok) {
        throw Object.assign(new Error('Activation refused'), reply.error)
      }
      return true
    },
    reveal: async (target) => {
      if (target.agent && !isStructuredAgentId(target.agent)) {
        return { reason: 'unsupported', beforeEffects: true }
      }
      const reply = await stage((options) =>
        structuredOpenReveal.request(
          args.client,
          {
            sessionId: target.sessionId,
            navigation: 'caller',
            ...(args.botLinkTarget ? { botLinkTarget: args.botLinkTarget } : {})
          },
          options
        )
      )
      if (!reply.ok) {
        return structuredSessionOpenFailure(reply.error)
      }
      const result = structuredOpenReveal.interpret(reply)
      return result.ok
        ? { sessionId: result.sessionId, worktreeId: result.workspaceId, agent: result.agent }
        : structuredSessionOpenFailure(result.refusal)
    }
  })
}

export function mobileStructuredSessionHref(
  hostId: string,
  target: StructuredSessionOpenTarget,
  tab: StructuredSessionOpenTab
): string {
  const paneKey = structuredAgentSessionPaneKey(tab.id, target.sessionId)
  return `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(target.worktreeId)}?paneKey=${encodeURIComponent(paneKey)}`
}
