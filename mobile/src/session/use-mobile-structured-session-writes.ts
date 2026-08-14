import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionSendRequest } from '../../../src/shared/structured-agent-session-outbox'
import type { RpcClient } from '../transport/rpc-client'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import {
  startMobileStructuredOutboxHydration,
  waitForMobileStructuredOutboxHydration,
  type MobileStructuredOutboxHydration
} from './mobile-structured-outbox-hydration'
import {
  createQueuedMobileStructuredOutboxEntry,
  isMobileStructuredDeliveryUnknown,
  requeueMobileStructuredSendRefusal
} from './mobile-structured-outbox-entry'
import type { MobileStructuredOutboxEntry } from './mobile-structured-outbox-store'
import { useMobileStructuredOutboxPersistence } from './use-mobile-structured-outbox-persistence'
import { useMobileStructuredOutboxMutations } from './use-mobile-structured-outbox-mutations'
import { useMobileStructuredSessionMutations } from './use-mobile-structured-session-mutations'
import type { MobileStructuredSessionWrites } from './mobile-structured-session-write-types'

export type { MobileStructuredSessionWrites }

export function useMobileStructuredSessionWrites(args: {
  client: RpcClient | null
  connected: boolean
  sessionId: string | null
  fence: number | null
  submissions: readonly AgentJournalSubmission[]
  handoffOperationId?: string | null
}): MobileStructuredSessionWrites {
  const { client, connected, sessionId, fence, submissions } = args
  const [outbox, setOutbox] = useState<MobileStructuredOutboxEntry[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dispatchVersion, setDispatchVersion] = useState(0)
  const outboxRef = useRef<MobileStructuredOutboxEntry[]>([])
  const hydrationRef = useRef<MobileStructuredOutboxHydration | null>(null)
  const dispatchingRef = useRef(false)
  const dispatchGenerationRef = useRef(0)
  const blockedIdRef = useRef<string | null>(null)
  const activeSessionRef = useRef(sessionId)
  const activeFenceRef = useRef(fence)
  const persist = useMobileStructuredOutboxPersistence()
  const mutations = useMobileStructuredSessionMutations({
    client,
    sessionId,
    fence,
    handoffOperationId: args.handoffOperationId,
    onRefusal: setError
  })
  const outboxMutations = useMobileStructuredOutboxMutations({
    activeSessionRef,
    hydrationRef,
    outboxRef,
    setOutbox,
    persist
  })

  useEffect(() => {
    outboxMutations.beginSession()
    activeSessionRef.current = sessionId
    dispatchGenerationRef.current += 1
    dispatchingRef.current = false
    setOutbox([])
    outboxRef.current = []
    setHydrated(false)
    setError(null)
    blockedIdRef.current = null
    hydrationRef.current = null
    if (!sessionId) {
      return
    }
    const hydration = startMobileStructuredOutboxHydration(sessionId, (entries) => {
      outboxRef.current = entries
      setOutbox(entries)
      setHydrated(true)
    })
    hydrationRef.current = hydration
    return hydration.cancel
  }, [outboxMutations, sessionId])

  useEffect(() => {
    if (!sessionId || submissions.length === 0 || outboxRef.current.length === 0) {
      return
    }
    void outboxMutations.reconcile(sessionId, submissions)
  }, [outboxMutations, sessionId, submissions])

  useEffect(() => {
    activeSessionRef.current = sessionId
    activeFenceRef.current = fence
    dispatchGenerationRef.current += 1
    dispatchingRef.current = false
    blockedIdRef.current = null
    if (sessionId) {
      void outboxMutations.normalizeDispatching(sessionId)
    }
    if (connected) {
      setDispatchVersion((current) => current + 1)
    }
  }, [connected, fence, outboxMutations, sessionId])

  const replaceEntry = useCallback(
    async (
      id: string,
      update: (entry: MobileStructuredOutboxEntry) => MobileStructuredOutboxEntry | null
    ): Promise<void> => {
      if (!sessionId) {
        return
      }
      await outboxMutations.replaceEntry(sessionId, id, update)
    },
    [outboxMutations, sessionId]
  )

  useEffect(() => {
    const head = outbox[0]
    const next = head?.state === 'queued' ? head : null
    if (
      !client ||
      !connected ||
      !sessionId ||
      fence === null ||
      !hydrated ||
      !next ||
      dispatchingRef.current ||
      blockedIdRef.current === next.clientMessageId ||
      client.getState() !== 'connected'
    ) {
      return
    }
    dispatchingRef.current = true
    const targetGeneration = dispatchGenerationRef.current
    const targetSessionId = sessionId
    const targetFence = fence
    void (async () => {
      try {
        await replaceEntry(next.clientMessageId, (entry) => ({
          ...entry,
          state: 'dispatching',
          lastAttemptAt: Date.now()
        }))
        const response = await client.sendRequest(
          'agentSession.send',
          structuredAgentSessionSendRequest(next, fence)
        )
        if (activeSessionRef.current !== targetSessionId) {
          return
        }
        if (dispatchGenerationRef.current !== targetGeneration) {
          return
        }
        if (activeFenceRef.current !== targetFence) {
          await replaceEntry(next.clientMessageId, (entry) => ({ ...entry, state: 'queued' }))
          return
        }
        if (!response.ok) {
          throw new Error(response.error.message)
        }
        const result = response.result as AgentSessionMutationResult<AgentSessionSendResult>
        if (!result.ok) {
          setError(result.refusal.message)
          await replaceEntry(next.clientMessageId, (entry) => {
            const requeued = requeueMobileStructuredSendRefusal(entry, result.refusal.code)
            blockedIdRef.current = requeued.clientMessageId
            return requeued
          })
          return
        }
        if (result.value.submission.dispatchState === 'unknown') {
          await replaceEntry(next.clientMessageId, (entry) => ({
            ...entry,
            state: 'unconfirmed',
            retryAfterUnknownSubmittedAt: null
          }))
          return
        }
        if (result.value.submission.dispatchState === 'rejected') {
          blockedIdRef.current = next.clientMessageId
          setError(result.value.submission.reason ?? 'Message was not accepted')
          await replaceEntry(next.clientMessageId, (entry) => ({ ...entry, state: 'queued' }))
          return
        }
        setError(null)
        await replaceEntry(next.clientMessageId, () => null)
      } catch (caught) {
        if (activeSessionRef.current !== targetSessionId) {
          return
        }
        if (dispatchGenerationRef.current !== targetGeneration) {
          return
        }
        if (activeFenceRef.current !== targetFence) {
          await replaceEntry(next.clientMessageId, (entry) => ({ ...entry, state: 'queued' }))
          return
        }
        if (isMobileStructuredDeliveryUnknown(caught)) {
          await replaceEntry(next.clientMessageId, (entry) => ({
            ...entry,
            state: 'unconfirmed',
            retryAfterUnknownSubmittedAt: null
          }))
        } else {
          blockedIdRef.current = next.clientMessageId
          setError(caught instanceof Error ? caught.message : 'Message was not sent')
          await replaceEntry(next.clientMessageId, (entry) => ({ ...entry, state: 'queued' }))
        }
      } finally {
        if (dispatchGenerationRef.current === targetGeneration) {
          dispatchingRef.current = false
          setDispatchVersion((current) => current + 1)
        }
      }
    })()
  }, [client, connected, dispatchVersion, fence, hydrated, outbox, replaceEntry, sessionId])

  const send = useCallback(
    async (text: string, attachments: readonly PendingNativeChatImage[] = []): Promise<boolean> => {
      if (!sessionId || (!text.trim() && attachments.length === 0)) {
        return false
      }
      const hydration = hydrationRef.current
      if (!hydration || !(await waitForMobileStructuredOutboxHydration(hydration, sessionId))) {
        setError('Chat session is still loading')
        return false
      }
      if (activeSessionRef.current !== sessionId || hydrationRef.current !== hydration) {
        return false
      }
      const entry = createQueuedMobileStructuredOutboxEntry({ sessionId, text, attachments })
      try {
        const saved = await outboxMutations.enqueue(sessionId, hydration, entry)
        if (saved) {
          setError(null)
        }
        return saved
      } catch {
        setError('Message could not be saved to the outbox')
        return false
      }
    },
    [outboxMutations, sessionId]
  )

  const takeQueuedForEdit = useCallback(
    async (clientMessageId: string): Promise<MobileStructuredOutboxEntry | null> => {
      const current = outboxRef.current.find((entry) => entry.clientMessageId === clientMessageId)
      if (!current || current.state !== 'queued') {
        return null
      }
      blockedIdRef.current = null
      await replaceEntry(clientMessageId, () => null)
      return current
    },
    [replaceEntry]
  )

  const retry = useCallback(
    async (clientMessageId: string): Promise<void> => {
      blockedIdRef.current = null
      setError(null)
      const unknown = submissions.find(
        (submission) =>
          submission.clientMessageId === clientMessageId && submission.dispatchState === 'unknown'
      )
      await replaceEntry(clientMessageId, (entry) => ({
        ...entry,
        state: 'queued',
        retryAfterUnknownSubmittedAt: unknown?.submittedAt ?? -1
      }))
    },
    [replaceEntry, submissions]
  )

  return useMemo(
    () => ({
      outbox,
      hydrated,
      error,
      send,
      takeQueuedForEdit,
      retry,
      ...mutations
    }),
    [error, hydrated, mutations, outbox, retry, send, takeQueuedForEdit]
  )
}
