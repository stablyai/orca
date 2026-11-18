import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { AgentActivityChange, AgentListRow } from './agent-list-rows'

// The host's bound on one request's pane keys.
const PANE_KEYS_PER_REQUEST = 500
const applied = rpcResultVariant('applied', z.object({ applied: z.literal(true) }))

const agentActivitySetReadWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentActivity.mobile-set-read',
    method: 'agentActivity.setRead',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: applied
  })
)
const agentActivityClearWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'agentActivity.mobile-clear',
    method: 'agentActivity.clear',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: applied
  })
)

export type AgentActivityFailure = Readonly<{ hostId: string; needsDesktopWindow: boolean }>

async function sendAgentActivity(
  client: RpcClient,
  paneKeys: string[],
  change: AgentActivityChange
): Promise<void> {
  for (let start = 0; start < paneKeys.length; start += PANE_KEYS_PER_REQUEST) {
    const chunk = paneKeys.slice(start, start + PANE_KEYS_PER_REQUEST)
    if ('cleared' in change) {
      agentActivityClearWrite.interpret(
        await agentActivityClearWrite.request(client, { paneKeys: chunk })
      )
    } else {
      agentActivitySetReadWrite.interpret(
        await agentActivitySetReadWrite.request(client, { paneKeys: chunk, read: !change.unread })
      )
    }
  }
}

/**
 * Sends read and clear changes to each row's desktop, showing them until that desktop's next
 * list read carries them; a refused write rolls back to the desktop's list and reports which
 * desktop refused.
 */
export function useAgentActivityWrites(
  clients: readonly { hostId: string; client: RpcClient }[],
  refetchHost: (hostId: string) => Promise<void>
) {
  const [pending, setPending] = useState<
    Readonly<Record<string, { change: AgentActivityChange; token: number }>>
  >({})
  const tokenRef = useRef(0)
  const clientsRef = useRef(clients)
  useEffect(() => {
    clientsRef.current = clients
  }, [clients])

  const apply = useCallback(
    async (
      rows: readonly AgentListRow[],
      change: AgentActivityChange
    ): Promise<AgentActivityFailure[]> => {
      tokenRef.current += 1
      const token = tokenRef.current
      const paneKeysByHost = new Map<string, string[]>()
      for (const row of rows) {
        paneKeysByHost.set(row.hostId, [
          ...(paneKeysByHost.get(row.hostId) ?? []),
          row.entry.agent.paneKey
        ])
      }
      setPending((previous) => ({
        ...previous,
        ...Object.fromEntries(rows.map((row) => [row.key, { change, token }]))
      }))
      const settle = (hostId: string) =>
        setPending((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(
              ([key, entry]) => entry.token !== token || !key.startsWith(`${hostId}:`)
            )
          )
        )
      const outcomes = await Promise.all(
        [...paneKeysByHost].map(
          async ([hostId, paneKeys]): Promise<AgentActivityFailure | null> => {
            try {
              const client = clientsRef.current.find((entry) => entry.hostId === hostId)?.client
              if (!client) {
                throw new Error('desktop not connected')
              }
              await sendAgentActivity(client, paneKeys, change)
              // The host's next list already carries the change; hold the guess until it lands.
              await refetchHost(hostId)
              return null
            } catch (error) {
              // A timeout or a partial batch may still have applied; roll back to what the desktop has.
              await refetchHost(hostId)
              return {
                hostId,
                needsDesktopWindow:
                  error instanceof Error &&
                  error.message.includes('agent_activity_needs_desktop_window')
              }
            } finally {
              settle(hostId)
            }
          }
        )
      )
      return outcomes.filter((outcome): outcome is AgentActivityFailure => outcome !== null)
    },
    [refetchHost]
  )

  const pendingActivity = useMemo(
    () => Object.fromEntries(Object.entries(pending).map(([key, entry]) => [key, entry.change])),
    [pending]
  )
  return { pendingActivity, apply }
}
