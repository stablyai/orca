import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../src/shared/structured-agent-session-options'
import type { SessionOptionValue } from '../../../src/shared/native-chat-session-options'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

const CODEX_CATALOG = getAgentSessionOptionCatalog('codex')

export function useMobileStructuredSessionOptions(args: {
  client: RpcClient | null
  connected: boolean
  sessionId: string | null
  fence: number | null
  setOption: (key: string, value: string) => Promise<AgentSessionOptionResult | null>
}): MobileNativeChatSessionOptionsController {
  const { client, connected, fence, sessionId, setOption: dispatchOption } = args
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState('codex')
  )
  const [pickerRequest, setPickerRequest] = useState<{ id: string; token: number } | null>(null)
  const activeRecordRef = useRef(optionState.record)
  useEffect(() => {
    const next = createStructuredAgentSessionOptionState('codex')
    activeRecordRef.current = next.record
    setOptionState(next)
  }, [fence, sessionId])

  useEffect(() => {
    setPickerRequest(null)
    if (!client || !connected || !sessionId || !CODEX_CATALOG) {
      return
    }
    let stale = false
    void client
      .sendRequest('agentSession.options', { sessionId })
      .then((response) => {
        if (stale || !response.ok) {
          return
        }
        const result = response.result as AgentSessionOptionsResult
        setOptionState((current) =>
          current.record === activeRecordRef.current
            ? applyStructuredAgentSessionOptions(current, CODEX_CATALOG, result)
            : current
        )
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [client, connected, fence, sessionId])

  const snapshot = useMemo(
    () => (sessionId ? structuredAgentSessionOptionSnapshot(optionState) : []),
    [optionState, sessionId]
  )

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      if (!sessionId || !canSetStructuredAgentSessionOption(optionState, id, value)) {
        return false
      }
      if (typeof value !== 'string') {
        return false
      }
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await dispatchOption(id, value)
        if (!result || activeRecordRef.current !== targetRecord) {
          return false
        }
        setOptionState((current) =>
          commitStructuredAgentSessionOptionValues(current, result.options ?? { [id]: value })
        )
        return true
      } finally {
        setOptionState((current) =>
          current.record === targetRecord && current.pendingId === id
            ? { ...current, pendingId: null }
            : current
        )
      }
    },
    [dispatchOption, optionState, sessionId]
  )

  const invokeAction = useCallback(
    async (id: string): Promise<boolean> => {
      if (!snapshot.some((descriptor) => descriptor.id === id)) {
        return false
      }
      setPickerRequest({ id, token: Date.now() })
      return true
    },
    [snapshot]
  )

  return useMemo(
    () => ({
      snapshot,
      pendingId: optionState.pendingId,
      setOption,
      invokeAction,
      recordCommand: () => {},
      pickerRequest,
      dismissPickerRequest: (token: number) =>
        setPickerRequest((current) => (current?.token === token ? null : current))
    }),
    [invokeAction, optionState.pendingId, pickerRequest, setOption, snapshot]
  )
}
