import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import {
  callAgentSession,
  type StructuredAgentSessionMutate
} from './mobile-structured-agent-session-rpc'

type StructuredOptionsController = {
  optionSnapshot: SessionOptionDescriptor[]
  optionSurface: SessionOptionsSurface
  pendingOptionId: string | null
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeStructuredOption: (id: string) => Promise<boolean>
}

export function useMobileStructuredAgentOptions(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  mutate: StructuredAgentSessionMutate
}): StructuredOptionsController {
  const { agent, client, enabled, fence, mutate, sessionId } = args
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex')
  )
  const activeOptionRecordRef = useRef(optionState.record)
  const optionCatalog = useMemo(
    () => (agent === 'claude' || agent === 'codex' ? getAgentSessionOptionCatalog(agent) : null),
    [agent]
  )

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent ?? 'codex')
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, sessionId])

  useEffect(() => {
    if (!client || !sessionId || !enabled || !optionCatalog) {
      return
    }
    let stale = false
    void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', { sessionId })
      .then((result) => {
        if (!stale) {
          setOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
              : current
          )
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client, enabled, optionCatalog, sessionId, fence])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      if (
        !canSetStructuredAgentSessionOption(optionState, id, value) ||
        typeof value !== 'string'
      ) {
        return false
      }
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value }
        )
        if (activeOptionRecordRef.current !== targetRecord) {
          return result.status !== 'rejected'
        }
        if (result.status === 'accepted') {
          setOptionState((current) =>
            current.record === targetRecord && result.sameFence
              ? commitStructuredAgentSessionOptionValues(
                  current,
                  result.value.options ?? { [id]: value }
                )
              : current
          )
          return true
        }
        if (result.status === 'unknown') {
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOption(current, id, value)
              : current
          )
          return true
        }
        return false
      } finally {
        setOptionState((current) =>
          current.record === targetRecord && current.pendingId === id
            ? { ...current, pendingId: null }
            : current
        )
      }
    },
    [mutate, optionState]
  )

  const invokeStructuredOption = useCallback(async () => false, [])

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return { snapshot: optionSnapshot }
    },
    [optionSnapshot, setStructuredOption]
  )

  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption]
  )

  return {
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    setStructuredOption,
    invokeStructuredOption
  }
}
