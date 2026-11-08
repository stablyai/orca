import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'
import { projectRuntimePermission } from '../../../src/shared/agent-session/options/structured-agent-session-permission-option'
import { useMobileStructuredSelectionController } from './use-mobile-structured-selection-controller'
import type { AgentSessionRewindSupport } from '../../../src/shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { forgetMobileCreatedStructuredSession } from './mobile-created-structured-sessions'
import { createStructuredAgentSessionOptionsReadOwner } from '../../../src/shared/agent-session/options/structured-agent-session-options-read-owner'
import { BoundedMap } from '../../../src/shared/bounded-map'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import { usesInstalledAgentModelCatalog } from '../../../src/shared/agent-session/options/agent-model-catalog-ownership'
import { structuredAgentSessionFirstFrameOptionState } from '../../../src/shared/agent-session/options/structured-agent-session-first-frame'
import type { HostModelCatalogCache } from './use-mobile-host-model-catalog-upgrade'
import { structuredAgentSessionReportsAtFence } from '../../../src/shared/agent-session/options/structured-agent-session-runtime-reports'

// Matches the transcripts this view retains per chat.
const MAX_RETAINED_CHAT_READERS = 32
const UNSUPPORTED_REWIND: AgentSessionRewindSupport = { supported: false, reason: 'unsupported' }

export function useMobileStructuredOptionState(args: {
  modelCatalogCache?: HostModelCatalogCache | null
  client: RpcClient | null
  optionStamp?: string
  sendSelection?: boolean
  newLaunch: boolean
  worktree?: string
  coherentCatalog?: boolean
  agent: string | null
  enabled: boolean
  statusFeed: boolean
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  sessionId: string | null
  turnId: string | null
  unloadedTurnRevisions: number | undefined
}) {
  const {
    agent,
    enabled,
    statusFeed,
    fence,
    optionCatalog,
    sessionId,
    turnId,
    unloadedTurnRevisions,
    modelCatalogCache,
    client,
    optionStamp,
    sendSelection,
    newLaunch,
    worktree,
    coherentCatalog: hostCoherentCatalog = false
  } = args
  const connected = useSyncExternalStore(
    client?.onStateChange ?? (() => () => {}),
    () => client?.getState() === 'connected'
  )
  const feed =
    enabled && connected && statusFeed && client && sessionId
      ? mobileStructuredSessionStatusFeed(client)
      : null
  const summary = useSyncExternalStore(feed?.subscribe ?? (() => () => {}), () =>
    sessionId ? feed?.getSnapshot().get(sessionId) : undefined
  )
  const providerStarting = summary?.hostExecutionPhase === 'starting'
  const coherentCatalog = usesInstalledAgentModelCatalog(agent ?? '', hostCoherentCatalog)
  // The host's last list for this agent when this world holds one, else the quiet placeholder until the host answers.
  const firstFrame = () =>
    structuredAgentSessionFirstFrameOptionState(
      agent ?? 'codex',
      optionCatalog,
      modelCatalogCache?.seed({ newLaunch, seedsModel: false, ...(worktree ? { worktree } : {}) }),
      { newLaunch, coherentCatalog }
    )
  // One view serves every chat tab, so each chat keeps its own reader and its last answer on return.
  const [readers] = useState(
    () =>
      new BoundedMap<string, ReturnType<typeof createStructuredAgentSessionOptionsReadOwner>>({
        maxEntries: MAX_RETAINED_CHAT_READERS
      })
  )
  const chatKey = JSON.stringify([agent, sessionId])
  const reader = useMemo(() => {
    const retained = readers.get(chatKey)
    if (retained) {
      return retained
    }
    const created = createStructuredAgentSessionOptionsReadOwner(firstFrame())
    readers.set(chatKey, created)
    return created
  }, [readers, chatKey, agent, optionCatalog])
  useEffect(() => () => reader.markAway(), [reader])
  // An older fence's report is stale from the render its fence changes in, before re-attach clears it.
  const projectRuntimeReports = <
    T extends { reportedPermissionMode?: string | null; reportedEffort?: string }
  >(
    state: T
  ): T =>
    projectRuntimePermission(
      structuredAgentSessionReportsAtFence(state, reader.getSnapshot().support?.fence, fence),
      summary,
      fence
    )
  const { optionState, support } = useSyncExternalStore(reader.subscribe, reader.getSnapshot)
  const {
    optionStateRef,
    activeOptionRecordRef,
    updateOptionState,
    receiveCatalog,
    invalidate: reread
  } = reader
  const { controller, clientGeneration } = useMobileStructuredSelectionController({
    agent,
    client,
    sessionId,
    onRevalidate: reread
  })
  const contextKey = JSON.stringify([agent, sessionId, newLaunch, worktree, fence, connected])
  const contextRef = useRef({ key: contextKey, client })
  useEffect(() => {
    contextRef.current = { key: contextKey, client }
  }, [contextKey, client])
  const isCurrentContext = useCallback(
    () => contextRef.current.key === contextKey && contextRef.current.client === client,
    [contextKey, client]
  )
  // Projected once per accepted answer so consumers keep stable references between answers.
  const { conversationSupport, imageSupport, threadGoalSupport, rewindSupport } = useMemo(
    () =>
      support && support.sessionId !== null
        ? {
            conversationSupport: {
              sessionId: support.sessionId,
              commands: support.result.conversationCommands ?? [],
              compactInstructions: support.result.compactInstructions === true,
              forkSupport: support.result.forkSupport,
              contextUsage: support.result.contextUsage
            },
            imageSupport: {
              sessionId: support.sessionId,
              acceptsImages: support.result.acceptsImages,
              statesPermissionMode: support.result.current?.permissionMode !== undefined
            },
            threadGoalSupport: {
              sessionId: support.sessionId,
              support: support.result.threadGoal,
              reported: support.result.reportedThreadGoal
            },
            rewindSupport: {
              sessionId: support.sessionId,
              fence: support.fence,
              support: support.result.rewind ?? UNSUPPORTED_REWIND,
              contextFloor:
                support.result.contextUsage?.contextFloor ?? support.result.threadGoal?.contextFloor
            }
          }
        : {
            conversationSupport: null,
            imageSupport: null,
            threadGoalSupport: null,
            rewindSupport: null
          },
    [support]
  )
  useEffect(
    () =>
      reader.attach({
        owner: [agent, sessionId, client],
        reset: [contextKey, clientGeneration, enabled, optionCatalog],
        sessionId,
        fence,
        seed: firstFrame,
        controller,
        eligible:
          !!client &&
          !!sessionId &&
          enabled &&
          !!optionCatalog &&
          (!providerStarting || !newLaunch || !!sendSelection),
        optionCatalog,
        newLaunch,
        coherentCatalog,
        authority: () => client?.getGeneration?.(),
        isCurrent: isCurrentContext,
        request: () => {
          if (!client || !sessionId) {
            throw new Error('Options reader is not attached')
          }
          return callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', {
            sessionId
          })
        },
        accepted: () => {
          if (sessionId) {
            forgetMobileCreatedStructuredSession(sessionId)
          }
        }
      }),
    [
      reader,
      agent,
      sessionId,
      client,
      controller,
      contextKey,
      clientGeneration,
      enabled,
      optionCatalog,
      fence,
      newLaunch,
      coherentCatalog,
      providerStarting,
      sendSelection,
      isCurrentContext
    ]
  )
  // A turn or host status change rereads within the same lease, as on desktop; it is not a new context.
  // So does a turn row leaving the loaded window, whose context facts only the host's answer still holds.
  const contextRefresh = conversationSupport?.contextUsage ? (unloadedTurnRevisions ?? 0) : 0
  const readStamp = JSON.stringify([optionStamp, turnId, contextRefresh])
  const seenReadStamp = useRef(readStamp)
  useEffect(() => {
    if (seenReadStamp.current !== readStamp) {
      seenReadStamp.current = readStamp
      reread()
    }
  }, [readStamp, reread])

  return {
    projectRuntimeReports,
    conversationSupport,
    imageSupport,
    threadGoalSupport,
    rewindSupport,
    /** The host's in-doubt rewind latch, from its status feed. */
    rewindBlockedReason: summary?.rewindBlockedReason ?? undefined,
    controller,
    reread,
    receiveCatalog,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    providerStarting,
    updateOptionState
  }
}
