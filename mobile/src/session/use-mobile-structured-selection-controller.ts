import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { createStructuredSessionSelectionController } from '../../../src/shared/structured-agent-session-selection-operations'
import { persistMobileStructuredOptionPicks } from './native-chat/input/mobile-native-chat-session-option-persistence'
import type { RpcClient } from '../transport/rpc-client'

/** Temporary operations belong to one phone authority, above its queried host answer. */
export function useMobileStructuredSelectionController(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  onRevalidate: () => void
}) {
  const { agent, client, sessionId, onRevalidate } = args
  const clientGeneration = useSyncExternalStore(client?.onStateChange ?? (() => () => {}), () =>
    client?.getGeneration?.()
  )
  const scope = useMemo(() => {
    let attached = true
    const controller = createStructuredSessionSelectionController(
      (picks) => {
        if (agent) {
          void persistMobileStructuredOptionPicks({ client, agent, picks })
        }
      },
      () => attached
    )
    return {
      controller,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
        controller.abandon()
      }
    }
  }, [agent, client, sessionId])
  const { controller } = scope
  useEffect(() => {
    scope.attach()
    return scope.detach
  }, [scope])
  const selectionRevision = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const terminal = controller.terminalSnapshot()
  useEffect(() => {
    if (terminal) {
      onRevalidate()
    }
  }, [terminal, onRevalidate])
  useEffect(() => {
    return client?.onStateChange((state) => {
      if (state === 'connected') {
        onRevalidate()
      }
    })
  }, [client, controller, onRevalidate])
  return { controller, selectionRevision, clientGeneration }
}
