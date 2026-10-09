import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MobileStructuredAgentOptionsArgs,
  StructuredOptionsController
} from './mobile-structured-options-controller'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
import type { AgentSessionOptionResult } from '../../../src/shared/agent-session-wire'
import type { SessionOptionValue } from '../../../src/shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  reseedStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import { structuredAgentSessionOptionPicks } from '../../../src/shared/structured-agent-session-option-picks'
import { persistMobileStructuredOptionPicks } from './mobile-native-chat-session-option-persistence'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'
import { forgetMobileCreatedStructuredSession } from './mobile-created-structured-sessions'
import { encodeStructuredAgentSessionOptionValue } from '../../../src/shared/structured-agent-session-option-codec'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode
} from '../../../src/shared/agent-chat-permission-mode'
import {
  useMobilePermissionPicker,
  useMobileStructuredPermissionState
} from './use-mobile-structured-permission-state'
import { useMobileStructuredOptionSurface } from './use-mobile-structured-option-surface'
import { readMobileStructuredOptions } from './mobile-structured-options-read'

export function useMobileStructuredAgentOptions(
  args: MobileStructuredAgentOptionsArgs
): StructuredOptionsController {
  const {
    agent,
    client,
    enabled,
    fence,
    mutate,
    sessionId,
    connected = true,
    turnId,
    providerPhase,
    permissionMode,
    unloadedTurnRevisions
  } = args
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
  const optionReadGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const { permission, begin, confirmRead, confirmWrite, getFence, pending } =
    useMobileStructuredPermissionState(args)
  const permissionView = useCallback(
    (current: StructuredAgentSessionOptionState) =>
      current.permission === permission ? current : { ...current, permission },
    [permission]
  )

  const optionIdentityRef = useRef(JSON.stringify([args.sessionKey, agent, sessionId]))
  useEffect(() => {
    const identity = JSON.stringify([args.sessionKey, agent, sessionId])
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const next = reseedStructuredAgentSessionOptionState(
      optionStateRef.current,
      createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog),
      sameSession
    )
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, optionCatalog, sessionId, args.sessionKey])

  useMobileHostModelCatalogUpgrade({
    agent,
    client,
    sessionId,
    enabled,
    fence,
    optionCatalog,
    activeOptionRecordRef,
    updateOptionState
  })

  useEffect(() => {
    if (!client || !sessionId || !enabled || !connected || !optionCatalog) {
      return
    }
    let stale = false
    const readGeneration = optionMutationGeneration.current
    const permissionRead = begin()
    readMobileStructuredOptions({
      client,
      sessionId,
      generation: optionReadGeneration,
      isCurrent: () => !stale && optionMutationGeneration.current === readGeneration,
      onAnswer: (result) => {
        // This view keeps its latch; a later one may run a model picked here.
        forgetMobileCreatedStructuredSession(sessionId)
        confirmRead(permissionRead, result.permissionModes)
      },
      onResult: (result) => {
        setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
        updateOptionState((current) =>
          current.record === activeOptionRecordRef.current
            ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
            : current
        )
      }
    })
    return () => {
      stale = true
    }
  }, [
    client,
    connected,
    enabled,
    optionCatalog,
    sessionId,
    fence,
    turnId,
    providerPhase,
    permissionMode,
    unloadedTurnRevisions,
    args.sessionKey,
    begin,
    confirmRead,
    updateOptionState
  ])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      const currentState = permissionView(optionStateRef.current)
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
      const permissionWrite = begin(
        id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID && isAgentChatPermissionMode(encoded)
          ? encoded
          : undefined
      )
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      const refreshOptions = (): void => {
        const permissionRead = begin()
        readMobileStructuredOptions({
          client,
          sessionId,
          generation: optionReadGeneration,
          isCurrent,
          onAnswer: (answer) => confirmRead(permissionRead, answer.permissionModes),
          onResult: (refreshed) => {
            updateOptionState((latest) =>
              applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
            )
          }
        })
      }
      pendingOptionRef.current = id
      updateOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded },
          ...(id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ? ([getFence()] as const) : [])
        )
        if (result.status === 'accepted') {
          confirmWrite(
            permissionWrite,
            result.value.options?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ??
              (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID && result.sameFence
                ? result.value.value
                : undefined),
            result.value.permissionFact
          )
        }
        if (!isCurrent()) {
          return (
            result.status === 'accepted' ||
            (result.status === 'unknown' && id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID)
          )
        }
        if (result.status === 'accepted') {
          const committed = result.value.options ?? { [id]: encoded }
          updateOptionState((current) =>
            current.record === targetRecord && result.sameFence
              ? commitStructuredAgentSessionOptionValues(permissionView(current), committed)
              : current
          )
          // Only accepted per-model picks become the next chat's default: an `unknown` outcome
          // commits optimistically, and remembering one the provider refused would seed a launch
          // the user never chose.
          if (agent && id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
            void persistMobileStructuredOptionPicks({
              client,
              agent,
              picks: structuredAgentSessionOptionPicks(currentState, committed)
            })
          }
          if (result.sameFence) {
            refreshOptions()
          }
          return true
        }
        if (result.status === 'unknown') {
          if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
            // A read confirms current host intent, not the fate of a write still in transit.
            refreshOptions()
            return false
          }
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOption(current, id, encoded)
              : current
          )
          return true
        }
        return false
      } finally {
        confirmWrite(permissionWrite)
        if (isCurrent()) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [
      agent,
      client,
      mutate,
      optionCatalog,
      permissionView,
      sessionId,
      updateOptionState,
      begin,
      confirmRead,
      confirmWrite,
      getFence
    ]
  )

  const { optionPickerRequest, invokeStructuredOption, optionSurface } =
    useMobileStructuredOptionSurface(optionSnapshot, optionStateRef, setStructuredOption)

  const permissionPicker = useMobilePermissionPicker(
    agent,
    permission,
    pending || optionState.pendingId !== null,
    setStructuredOption
  )

  return {
    permissionPicker,
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
