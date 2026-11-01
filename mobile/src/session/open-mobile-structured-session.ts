import {
  openStructuredAgentSession,
  structuredSessionOpenFailure,
  type StructuredSessionOpenSource,
  type StructuredSessionOpenTab,
  type StructuredSessionOpenTarget
} from '../../../src/shared/open-structured-agent-session'
import { isStructuredAgentId } from '../../../src/shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { structuredAgentSessionPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { RpcClient } from '../transport/rpc-client'
import {
  structuredOpenLocation,
  structuredOpenReveal,
  structuredOpenTabs
} from './mobile-structured-session-open-rpc'
import { sessionTabActivate } from './mobile-session-write-operations'

/** The workspace client already carries executionHost; a single budget includes connect waits. */
export async function openMobileStructuredSession(args: {
  client: RpcClient
  source: StructuredSessionOpenSource
  current: () => boolean
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
    args.current() &&
    args.client.getState() === 'connected' &&
    args.client.getGeneration?.() === generation &&
    Date.now() < deadline
  const stage = async <T>(
    request: (options: {
      timeoutMs: number
      budgetSpansConnect: boolean
      failWhenDisconnected: boolean
    }) => Promise<T>
  ): Promise<T> => {
    if (!current()) {
      throw new Error('Opening no longer belongs to this view')
    }
    const timeoutMs = Math.min(5_000, deadline - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        request({ timeoutMs, budgetSpansConnect: true, failWhenDisconnected: true }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Opening timed out')), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const tabs = new Map<string, readonly StructuredSessionOpenTab[]>(
    args.inventory ? [[args.inventory.worktreeId, args.inventory.tabs]] : []
  )
  return openStructuredAgentSession(args.source, {
    current: () =>
      args.current() &&
      args.client.getState() === 'connected' &&
      args.client.getGeneration?.() === generation,
    locate: async (address, messageIds) => {
      const reply = await stage((options) =>
        structuredOpenLocation.request(
          args.client,
          { address, ...(messageIds.length ? { messageIds: [...messageIds] } : {}) },
          options
        )
      )
      if (!reply.ok) {
        return structuredSessionOpenFailure(reply.error)
      }
      return structuredOpenLocation.interpret(reply)
    },
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
            intent: 'user'
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
          { sessionId: target.sessionId, navigation: 'caller' },
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
