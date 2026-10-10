import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
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
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import {
  callAgentSession,
  type StructuredAgentSessionMutate
} from './mobile-structured-agent-session-rpc'
import { persistMobileStructuredOptionPicks } from './mobile-native-chat-session-option-persistence'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'
import {
  forgetMobileCreatedStructuredSession,
  mobileCreatedStructuredSession
} from './mobile-created-structured-sessions'
import { encodeStructuredAgentSessionOptionValue } from '../../../src/shared/structured-agent-session-option-codec'

type StructuredOptionsController = {
  optionPickerRequest: { id: string; sequence: number } | null
  conversationCommands: readonly AgentSessionConversationCommand[]
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
  // Every agent's seed, as on the desktop: a built-in list or the provider-default pill.
  const optionCatalog = useMemo(
    () => (agent ? structuredAgentSessionSeedCatalog(agent) : null),
    [agent]
  )
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const optionMutationGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
  } | null>(null)
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)

  const optionIdentityRef = useRef(`${agent}:${sessionId}`)
  useEffect(() => {
    const identity = `${agent}:${sessionId}`
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const previous = optionStateRef.current
    const seeded = createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    // A host answer is the account's, not the fence's: keep it rather than fall back to the placeholder.
    const next =
      sameSession && (previous.catalogSource === 'host' || previous.catalogSource === 'builtin')
        ? { ...seeded, catalog: previous.catalog, catalogSource: previous.catalogSource }
        : seeded
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, optionCatalog, sessionId])

  // A chat this phone created runs the listed default, as a desktop chat its own view launched does.
  const createdHere = useMemo(
    () => (sessionId ? mobileCreatedStructuredSession(sessionId) : undefined),
    [sessionId]
  )
  useMobileHostModelCatalogUpgrade({
    agent,
    client,
    sessionId,
    enabled,
    fence,
    newLaunch: createdHere !== undefined,
    ...(createdHere ? { worktree: createdHere.worktree } : {}),
    optionCatalog,
    activeOptionRecordRef,
    updateOptionState
  })

  useEffect(() => {
    if (!client || !sessionId || !enabled || !optionCatalog) {
      return
    }
    let stale = false
    const readGeneration = optionMutationGeneration.current
    void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', { sessionId })
      .then((result) => {
        // This view keeps its latch; a later one may run a model picked here.
        forgetMobileCreatedStructuredSession(sessionId)
        if (!stale && optionMutationGeneration.current === readGeneration) {
          setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
          updateOptionState((current) =>
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
  }, [client, enabled, optionCatalog, sessionId, fence, updateOptionState])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        pendingOptionRef.current !== null ||
        !client ||
        !sessionId ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(currentState, id, value)
      ) {
        return false
      }
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      pendingOptionRef.current = id
      updateOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (
          activeOptionRecordRef.current !== targetRecord ||
          optionMutationGeneration.current !== mutationGeneration
        ) {
          return result.status !== 'rejected'
        }
        if (result.status === 'accepted') {
          const committed = result.value.options ?? { [id]: encoded }
          updateOptionState((current) =>
            current.record === targetRecord && result.sameFence
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          // Only an accepted pick: an `unknown` outcome commits optimistically to the
          // visible record, and remembering one the provider refused would seed a
          // launch the user never chose.
          if (agent) {
            void persistMobileStructuredOptionPicks({
              client,
              agent,
              picks: structuredAgentSessionOptionPicks(currentState, committed)
            })
          }
          if (result.sameFence) {
            void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', {
              sessionId
            })
              .then((refreshed) => {
                if (
                  activeOptionRecordRef.current === targetRecord &&
                  optionMutationGeneration.current === mutationGeneration
                ) {
                  updateOptionState((latest) =>
                    latest.record === targetRecord
                      ? applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
                      : latest
                  )
                }
              })
              .catch(() => undefined)
          }
          return true
        }
        if (result.status === 'unknown') {
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOption(current, id, encoded)
              : current
          )
          return true
        }
        return false
      } finally {
        if (
          activeOptionRecordRef.current === targetRecord &&
          optionMutationGeneration.current === mutationGeneration
        ) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [agent, client, mutate, optionCatalog, sessionId, updateOptionState]
  )

  const invokeStructuredOption = useCallback(
    async (id: string) => {
      if (!optionSnapshot.some((entry) => entry.id === id)) {
        return false
      }
      setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
      return true
    },
    [optionSnapshot]
  )

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return { snapshot: structuredAgentSessionOptionSnapshot(optionStateRef.current) }
    },
    [setStructuredOption]
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
    optionPickerRequest,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : [],
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    setStructuredOption,
    invokeStructuredOption
  }
}
