import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session/agent-session-conversation-command'
import { useMobileStructuredOptionState } from './use-mobile-structured-option-state'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
import type { AgentSessionOptionResult } from '../../../src/shared/agent-session-wire'
import { lockedStructuredAgentSessionOptionSnapshot } from '../../../src/shared/structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection,
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../src/shared/structured-agent-session-option-view'
import { agentChatPermissionModes } from '../../../src/shared/agent-chat-permission-mode'
import { legacyHostPermissionDescriptor } from '../../../src/shared/structured-agent-session-permission-option'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import type { StructuredAgentSessionMutate } from './mobile-structured-agent-session-rpc'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'
import { mobileCreatedStructuredSession } from './mobile-created-structured-sessions'
import {
  acceptedStructuredSessionSelectionOutcome,
  createStructuredAgentSessionOptionsWriteOwner
} from '../../../src/shared/structured-agent-session-options-write-owner'
import { useMobileStructuredOptionSurface } from './use-mobile-structured-option-surface'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

export function useMobileStructuredAgentOptions(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  turnId: string | null
  mutate: StructuredAgentSessionMutate
  optionStamp?: string
  hostSupport: Pick<
    StructuredAgentSessionHostSupport,
    | 'permissionModes'
    | 'permissionOwn'
    | 'coherentModelCatalog'
    | 'statusFeed'
    | 'sendSelection'
    | 'sendOptions'
  > | null
}) {
  const { agent, client, enabled, fence, mutate, optionStamp, sessionId, turnId, hostSupport } =
    args
  const optionCatalog = useMemo(
    () => (agent ? structuredAgentSessionSeedCatalog(agent) : null),
    [agent]
  )
  const createdHere = useMemo(
    () => (sessionId ? mobileCreatedStructuredSession(sessionId) : undefined),
    [sessionId]
  )
  // An options answer made before the account's listing landed listed none of it.
  const {
    projectPermission,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    providerStarting,
    updateOptionState,
    conversationSupport,
    imageSupport,
    awaitingOptions,
    receiveCatalog,
    isCurrentContext,
    controller,
    reread
  } = useMobileStructuredOptionState({
    agent,
    enabled,
    statusFeed: hostSupport?.statusFeed === true,
    fence,
    optionCatalog,
    sessionId,
    turnId,
    client,
    optionStamp,
    sendSelection: hostSupport?.sendSelection === true,
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

  // Pre-1.4.225 hosts lack per-chat modes; show their actual global agent mode.
  const legacyHostPermissions =
    agent !== null &&
    agentChatPermissionModes(agent) !== null &&
    hostSupport?.permissionModes === false &&
    imageSupport?.sessionId === sessionId &&
    !imageSupport.statesPermissionMode &&
    optionState.permissionMode === null
  const interactionReadyRef = useRef(!awaitingOptions)
  const lockSnapshotRef = useRef(
    (snapshot: ReturnType<typeof structuredAgentSessionShownSnapshot>) => snapshot
  )
  const lockSnapshot = (snapshot: ReturnType<typeof structuredAgentSessionShownSnapshot>) =>
    awaitingOptions ? lockedStructuredAgentSessionOptionSnapshot(snapshot) : snapshot
  useLayoutEffect(() => {
    interactionReadyRef.current = !awaitingOptions
    lockSnapshotRef.current = lockSnapshot
  })
  const readOptionState = useCallback(
    () =>
      projectPermission({
        ...structuredAgentSessionOptionView(
          optionStateRef.current,
          undefined,
          controller.overlay()
        ),
        permissionOwnSupported: hostSupport ? hostSupport.permissionOwn === true : null
      }),
    [controller, projectPermission, hostSupport?.permissionOwn]
  )
  const shown = lockSnapshot(structuredAgentSessionShownSnapshot(readOptionState()))
  const optionSnapshot = legacyHostPermissions
    ? [...shown, legacyHostPermissionDescriptor()]
    : shown

  const readWriteContext = () => {
    const currentState = projectPermission({
      ...optionStateRef.current,
      permissionOwnSupported: hostSupport ? hostSupport.permissionOwn === true : null
    })
    const view = structuredAgentSessionOptionView(currentState, undefined, controller.overlay())
    return {
      controller,
      record: optionStateRef.current.record,
      view,
      snapshot: lockSnapshotRef.current(structuredAgentSessionShownSnapshot(view)),
      ready: !awaitingOptions && !!client && !!sessionId && interactionReadyRef.current,
      providerStarting,
      isCurrentContext,
      flush: (isCurrent: () => boolean) => {
        controller.flush(async (pick) => {
          // A queued pick never retargets a replacement runtime.
          if (!isCurrent()) {
            return { kind: 'superseded' }
          }
          const result = await mutate<AgentSessionOptionResult>(
            'agentSession.setOption',
            'agentSession.setOption',
            { key: pick.key, value: pick.value }
          )
          return result.status === 'accepted'
            ? acceptedStructuredSessionSelectionOutcome(pick, result.value.options)
            : result.status === 'unknown'
              ? { kind: 'unknown' }
              : { kind: 'refused' }
        })
      },
      revalidate: reread,
      revalidateOn: 'refused-current' as const
    }
  }
  const writeContextRef = useRef(readWriteContext)
  useLayoutEffect(() => {
    writeContextRef.current = readWriteContext
  })
  const writer = useMemo(
    () => createStructuredAgentSessionOptionsWriteOwner(() => writeContextRef.current()),
    []
  )
  useLayoutEffect(() => () => writer.detach(), [writer])
  const setStructuredOption = writer.setOption

  // Controls and capture derive from the same queried base and transient operations.
  const sendSelection = useCallback(() => {
    const view = structuredAgentSessionOptionView(
      optionStateRef.current,
      undefined,
      controller.overlay()
    )
    return hostSupport?.sendSelection
      ? { selection: structuredAgentSessionMessageSelection(view) }
      : hostSupport?.sendOptions
        ? { options: structuredAgentSessionSendSelection(view) }
        : {}
  }, [controller, hostSupport?.sendSelection, hostSupport?.sendOptions])

  const { optionPickerRequest, invokeStructuredOption, optionSurface } =
    useMobileStructuredOptionSurface({
      optionSnapshot,
      demandModelCatalog,
      lockSnapshot: (snapshot) => lockSnapshotRef.current(snapshot),
      setStructuredOption,
      readOptionState
    })

  return {
    optionPickerRequest,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : NO_COMMANDS,
    acceptsImages:
      (imageSupport?.sessionId === sessionId ? imageSupport.acceptsImages : undefined) ??
      (agent !== null && isAgentSessionHandleProvider(agent)),
    optionSnapshot,
    optionSurface,
    pendingOptionId: writer.pendingOptionId(controller, optionState.record),
    setStructuredOption,
    invokeStructuredOption,
    sendSelection
  }
}
