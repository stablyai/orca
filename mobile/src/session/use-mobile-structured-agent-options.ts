import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { useMobileStructuredOptionState } from './use-mobile-structured-option-state'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
import type { AgentSessionOptionResult } from '../../../src/shared/agent-session-wire'
import type { SessionOptionValue } from '../../../src/shared/native-chat-session-options'
import {
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionPicks
} from '../../../src/shared/structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection,
  structuredAgentSessionShownSnapshot
} from '../../../src/shared/structured-agent-session-option-view'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes
} from '../../../src/shared/agent-chat-permission-mode'
import { legacyHostPermissionDescriptor } from '../../../src/shared/structured-agent-session-permission-option'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { persistMobileStructuredOptionPicks } from './mobile-native-chat-session-option-persistence'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'
import { mobileCreatedStructuredSession } from './mobile-created-structured-sessions'
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
  hostSupport: Pick<
    StructuredAgentSessionHostSupport,
    'permissionModes' | 'coherentModelCatalog'
  > | null
}) {
  const { agent, client, enabled, fence, mutate, optionStamp, sessionId, hostSupport } = args
  // Every agent's seed, as on the desktop: a built-in list or the provider-default pill.
  const optionCatalog = useMemo(
    () => (agent ? structuredAgentSessionSeedCatalog(agent) : null),
    [agent]
  )
  // A chat this phone created runs the listed default, as a desktop chat its own view launched does.
  const createdHere = useMemo(
    () => (sessionId ? mobileCreatedStructuredSession(sessionId) : undefined),
    [sessionId]
  )
  const {
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    updateOptionState,
    conversationSupport,
    imageSupport,
    awaitingOptions,
    writes,
    readRef,
    receiveCatalog,
    isCurrentContext
  } = useMobileStructuredOptionState({
    agent,
    enabled,
    fence,
    optionCatalog,
    sessionId,
    client,
    optionStamp,
    newLaunch: createdHere !== undefined,
    worktree: createdHere?.worktree,
    coherentCatalog: hostSupport?.coherentModelCatalog === true
  })
  const demandModelCatalog = useMobileHostModelCatalogUpgrade({
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
    receiveCatalog
  })

  // A host predating per-chat modes (1.4.224 and older) states none: say what its chats run instead.
  const legacyHostPermissions =
    agent !== null &&
    agentChatPermissionModes(agent) !== null &&
    hostSupport?.permissionModes === false &&
    imageSupport?.sessionId === sessionId &&
    !imageSupport.statesPermissionMode &&
    optionState.permissionMode === null
  const lockSnapshotRef = useRef(
    (snapshot: ReturnType<typeof structuredAgentSessionShownSnapshot>) => snapshot
  )
  const lockSnapshot = (snapshot: ReturnType<typeof structuredAgentSessionShownSnapshot>) =>
    awaitingOptions ? lockedStructuredAgentSessionOptionSnapshot(snapshot) : snapshot
  useLayoutEffect(() => {
    lockSnapshotRef.current = lockSnapshot
  })
  const shown = lockSnapshot(structuredAgentSessionShownSnapshot(optionState))
  const optionSnapshot = legacyHostPermissions
    ? [...shown, legacyHostPermissionDescriptor()]
    : shown

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        !isCurrentContext() ||
        pendingOptionRef.current !== null ||
        !client ||
        !sessionId ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(
          structuredAgentSessionOptionView(currentState, undefined, {}),
          id,
          value,
          lockSnapshotRef.current(structuredAgentSessionShownSnapshot(currentState))
        )
      ) {
        return false
      }
      const targetRecord = currentState.record
      writes.current.count += 1
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        isCurrentContext() &&
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
        if (isCurrent()) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
        if (isCurrentContext() && activeOptionRecordRef.current === targetRecord) {
          writes.current.count -= 1
          writes.current.readback ||= readsBack && isCurrent()
          if (!writes.current.count && writes.current.readback) {
            readRef.current?.()
          }
        }
      }
    },
    [
      agent,
      awaitingOptions,
      client,
      createdHere,
      mutate,
      optionCatalog,
      writes,
      isCurrentContext,
      sessionId,
      updateOptionState
    ]
  )

  // Read, not rendered: what the chat holds when the send goes out.
  const sendSelection = useCallback(
    () => structuredAgentSessionSendSelection(optionStateRef.current),
    []
  )
  const { optionPickerRequest, invokeStructuredOption, optionSurface } =
    useMobileStructuredOptionSurface({
      optionSnapshot,
      demandModelCatalog,
      setStructuredOption,
      optionStateRef,
      lockSnapshot: (snapshot) => lockSnapshotRef.current(snapshot)
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
    invokeStructuredOption,
    sendSelection
  }
}
