import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'
import { projectRuntimePermission } from '../../../src/shared/structured-agent-session-permission-option'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session/agent-session-conversation-command'
import type {
  AgentSessionOptionsResult,
  AgentSessionModelCatalogResult
} from '../../../src/shared/agent-session-wire'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { forgetMobileCreatedStructuredSession } from './mobile-created-structured-sessions'
import { createCoalescingKeyedRunner } from '../../../src/shared/coalescing-keyed-runner'
import type { RpcClient } from '../transport/rpc-client'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import { usesInstalledAgentModelCatalog } from '../../../src/shared/agent-model-catalog-ownership'
import { cloneStructuredAgentSessionOptionRecord } from '../../../src/shared/structured-agent-session-option-state'
import {
  createStructuredOptionPickBook,
  resetStructuredOptionPickBook
} from '../../../src/shared/structured-agent-session-option-pick-book'
import {
  createStructuredAgentSessionOptionState,
  applyStructuredAgentSessionOptions,
  applyStructuredAgentSessionModelCatalog,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'

export function useMobileStructuredOptionState(args: {
  client: RpcClient | null
  optionStamp?: string
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
  // As on desktop, a host still starting the provider holds option writes; picks show at once.
  const providerStarting = summary?.hostExecutionPhase === 'starting'
  const projectPermission = <T extends { reportedPermissionMode?: string | null }>(state: T): T =>
    projectRuntimePermission(state, summary, fence)
  const coherentCatalog = usesInstalledAgentModelCatalog(agent ?? '', hostCoherentCatalog)
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const optionPicks = useRef(createStructuredOptionPickBook())
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const contextKey = JSON.stringify([agent, sessionId, newLaunch, worktree, fence, connected])
  const contextRef = useRef({ key: contextKey, client })
  useEffect(() => {
    contextRef.current = { key: contextKey, client }
  }, [contextKey, client])
  const isCurrentContext = useCallback(
    () => contextRef.current.key === contextKey && contextRef.current.client === client,
    [contextKey, client]
  )
  const writes = useRef({ count: 0, readback: false })
  const optionIdentityRef = useRef(`${agent}:${sessionId}`)
  useEffect(() => {
    const identity = `${agent}:${sessionId}`
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const previous = optionStateRef.current
    const seeded = createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    // Retain account answers across fence changes instead of reviving placeholders.
    const kept =
      sameSession && previous.catalogSource !== 'seed' && previous.catalogSource !== null
        ? {
            ...previous,
            catalogSource: 'host' as const,
            record: cloneStructuredAgentSessionOptionRecord(previous.record),
            pendingId: null,
            reportedPermissionMode: undefined
          }
        : seeded
    // Keep the chat’s mode visible through provider restarts.
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    writes.current = { count: 0, readback: false }
    resetStructuredOptionPickBook(optionPicks.current)
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, optionCatalog, sessionId, contextKey, client])

  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    fence: number | null
  } | null>(null)
  const [imageSupport, setImageSupport] = useState<{
    sessionId: string
    acceptsImages: boolean | undefined
    statesPermissionMode: boolean
  } | null>(null)

  const awaitingOptions =
    conversationSupport?.sessionId === sessionId && conversationSupport.fence !== fence

  const readRef = useRef<(() => void) | null>(null)
  const receiveCatalog = (
    catalog: AgentSessionModelCatalogResult | null,
    _event: 'demand' | 'progress' | 'settled'
  ) => {
    updateOptionState((current) =>
      catalog && optionCatalog
        ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
            newLaunch,
            coherentCatalog
          })
        : settleStructuredAgentSessionBuiltinCatalog(current, false)
    )
    if (!coherentCatalog && catalog && catalog.origin !== 'unknown' && !catalog.listingInProgress) {
      readRef.current?.()
    }
  }
  useEffect(() => {
    // Read each turn and after provider start; before start only a resumed chat has model evidence.
    if (!client || !sessionId || !enabled || !optionCatalog || (providerStarting && newLaunch)) {
      return
    }
    let stale = false
    const run = createCoalescingKeyedRunner<void>()
    const request = () => {
      void run('options', 'latest', async () => {
        if (stale || !isCurrentContext()) {
          return
        }
        if (writes.current.count) {
          writes.current.readback = true
          return
        }
        writes.current.readback = false
        const record = activeOptionRecordRef.current
        const readGeneration = optionPicks.current.generation
        const result = await callAgentSession<AgentSessionOptionsResult>(
          client,
          'agentSession.options',
          { sessionId }
        )
        if (stale || !isCurrentContext() || activeOptionRecordRef.current !== record) {
          return
        }
        // Latch for this view; a later view may run the model selected here.
        forgetMobileCreatedStructuredSession(sessionId)
        setImageSupport({
          sessionId,
          acceptsImages: result.acceptsImages,
          statesPermissionMode: result.current?.permissionMode !== undefined
        })
        if (optionPicks.current.generation !== readGeneration) {
          return
        }
        setConversationSupport({ sessionId, fence, commands: result.conversationCommands ?? [] })
        updateOptionState((current) =>
          applyStructuredAgentSessionOptions(current, optionCatalog, result, {
            newLaunch,
            coherentCatalog
          })
        )
      }).catch(() => undefined)
    }
    readRef.current = request
    request()
    return () => {
      stale = true
      readRef.current = null
    }
  }, [
    client,
    newLaunch,
    enabled,
    optionCatalog,
    optionStamp,
    isCurrentContext,
    coherentCatalog,
    providerStarting,
    sessionId,
    fence,
    turnId,
    updateOptionState
  ])

  return {
    projectPermission,
    conversationSupport,
    imageSupport,
    awaitingOptions,
    writes,
    readRef,
    receiveCatalog,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    optionPicks,
    providerStarting,
    updateOptionState
  }
}
