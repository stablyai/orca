import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'
import { projectRuntimePermission } from '../../../src/shared/agent-session/options/structured-agent-session-permission-option'
import { useMobileStructuredSelectionController } from './use-mobile-structured-selection-controller'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session/options/agent-session-options-result'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { forgetMobileCreatedStructuredSession } from './mobile-created-structured-sessions'
import { createStructuredAgentSessionOptionsReadOwner } from '../../../src/shared/structured-agent-session-options-read-owner'
import type { RpcClient } from '../transport/rpc-client'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import { usesInstalledAgentModelCatalog } from '../../../src/shared/agent-model-catalog-ownership'
import {
  createStructuredAgentSessionOptionState,
  structuredAgentSessionReportsAtFence
} from '../../../src/shared/agent-session/options/structured-agent-session-options'

export function useMobileStructuredOptionState(args: {
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
}) {
  const {
    agent,
    enabled,
    statusFeed,
    fence,
    optionCatalog,
    sessionId,
    turnId,
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
  const [reader] = useState(() =>
    createStructuredAgentSessionOptionsReadOwner(
      createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    )
  )
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
  const { conversationSupport, imageSupport } = useMemo(
    () =>
      support && support.sessionId !== null
        ? {
            conversationSupport: {
              sessionId: support.sessionId,
              commands: support.result.conversationCommands ?? []
            },
            imageSupport: {
              sessionId: support.sessionId,
              acceptsImages: support.result.acceptsImages,
              statesPermissionMode: support.result.current?.permissionMode !== undefined
            }
          }
        : { conversationSupport: null, imageSupport: null },
    [support]
  )
  useEffect(
    () =>
      reader.attach({
        owner: [agent, sessionId, client, controller],
        reset: [contextKey, clientGeneration, enabled, optionCatalog],
        sessionId,
        fence,
        seed: () => createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog),
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
  const readStamp = JSON.stringify([optionStamp, turnId])
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
