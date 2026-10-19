import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { SessionOptionValue } from '../../../src/shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionShownSnapshot
} from '../../../src/shared/structured-agent-session-option-view'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes
} from '../../../src/shared/agent-chat-permission-mode'
import { legacyHostPermissionDescriptor } from '../../../src/shared/structured-agent-session-permission-option'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
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
import { useMobileStructuredOptionSurface } from './use-mobile-structured-option-surface'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

export function useMobileStructuredAgentOptions(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  mutate: StructuredAgentSessionMutate
  /** Moves when the host's status says a session option changed; each move re-reads them. */
  optionStamp?: string
  /** What the host advertised; null until its status probe answers. */
  hostSupport: Pick<StructuredAgentSessionHostSupport, 'permissionModes'> | null
}) {
  const { agent, client, enabled, fence, mutate, optionStamp, sessionId, hostSupport } = args
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
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const [imageSupport, setImageSupport] = useState<{
    sessionId: string
    acceptsImages: boolean | undefined
    /** The answer named the chat's permission mode, as only a host applying modes does. */
    statesPermissionMode: boolean
  } | null>(null)

  const optionIdentityRef = useRef(`${agent}:${sessionId}`)
  useEffect(() => {
    const identity = `${agent}:${sessionId}`
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const previous = optionStateRef.current
    const seeded = createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    // A host answer is the account's, not the fence's: keep it rather than fall back to the placeholder.
    const kept =
      sameSession && (previous.catalogSource === 'host' || previous.catalogSource === 'builtin')
        ? { ...seeded, catalog: previous.catalog, catalogSource: previous.catalogSource }
        : seeded
    // The chat's own, which a restart for a new mode keeps: the pill never blanks between them.
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
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
  // An options answer made before the account's listing landed listed none of it.
  const [listingsLanded, setListingsLanded] = useState(0)
  const onListingLanded = useCallback(() => setListingsLanded((count) => count + 1), [])
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
    updateOptionState,
    onListingLanded
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
        // Not an option value: a pick made during the read leaves it standing.
        if (!stale) {
          setImageSupport({
            sessionId,
            acceptsImages: result.acceptsImages,
            statesPermissionMode: result.current?.permissionMode !== undefined
          })
        }
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
  }, [
    client,
    enabled,
    optionCatalog,
    optionStamp,
    listingsLanded,
    sessionId,
    fence,
    updateOptionState
  ])

  // A host predating per-chat modes (1.4.224 and older) states none: say what its chats run instead.
  const legacyHostPermissions =
    agent !== null &&
    agentChatPermissionModes(agent) !== null &&
    hostSupport?.permissionModes === false &&
    imageSupport?.sessionId === sessionId &&
    !imageSupport.statesPermissionMode &&
    optionState.permissionMode === null
  const optionSnapshot = useMemo(() => {
    const shown = structuredAgentSessionShownSnapshot(optionState)
    return legacyHostPermissions ? [...shown, legacyHostPermissionDescriptor()] : shown
  }, [legacyHostPermissions, optionState])

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
        !canSetStructuredAgentSessionOption(
          structuredAgentSessionOptionView(currentState, undefined, {}),
          id,
          value
        )
      ) {
        return false
      }
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      // Record-only: shown at once, so the picker stays usable while the write waits behind a start.
      const shownAtOnce = id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      if (shownAtOnce) {
        updateOptionState((current) =>
          current.record === targetRecord
            ? commitStructuredAgentSessionOption(current, id, encoded)
            : current
        )
      } else {
        pendingOptionRef.current = id
        updateOptionState((current) => ({ ...current, pendingId: id }))
      }
      // A same-fence accepted write, or a shown one that failed, reads back what the host now holds.
      let readsBack = shownAtOnce
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (!isCurrent()) {
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
          readsBack = result.sameFence
          return true
        }
        if (result.status === 'unknown') {
          readsBack = false
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOption(current, id, encoded)
              : current
          )
          return true
        }
        return false
      } finally {
        if (readsBack && isCurrent()) {
          void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', {
            sessionId
          })
            .then((refreshed) => {
              if (isCurrent()) {
                updateOptionState((latest) =>
                  latest.record === targetRecord
                    ? applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
                    : latest
                )
              }
            })
            .catch(() => undefined)
        }
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
    [agent, client, mutate, optionCatalog, sessionId, updateOptionState]
  )

  const { optionPickerRequest, invokeStructuredOption, optionSurface } =
    useMobileStructuredOptionSurface({
      optionSnapshot,
      setStructuredOption,
      optionStateRef
    })

  return {
    optionPickerRequest,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : NO_COMMANDS,
    /** The chat takes images, as its options report says; else only Claude and Codex, as before. */
    acceptsImages:
      (imageSupport?.sessionId === sessionId ? imageSupport.acceptsImages : undefined) ??
      (agent !== null && isAgentSessionHandleProvider(agent)),
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    setStructuredOption,
    invokeStructuredOption
  }
}
