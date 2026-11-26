import { createElement, useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  closeMobileNativeChatTabDraft,
  returnMobileNativeChatInFlightSend,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

import {
  beginMobileNativeChatInFlightSend,
  readMobileNativeChatInFlightSend,
  releaseMobileNativeChatInFlightSends,
  settleRecordedMobileNativeChatInFlightSends
} from '../delivery/mobile-native-chat-in-flight-sends'
import {
  useMobileStructuredSends,
  type MobileStructuredSends
} from '../delivery/use-mobile-structured-sends'
import {
  type MobileStructuredSendConfirmation,
  type MobileStructuredSendRecord,
  useMobileStructuredSendRecorded
} from '../delivery/mobile-structured-send-recorded-read'
import { structuredAgentSessionHostSupport } from '../../agent-session/mobile-structured-agent-session-host-support'
import type { UnvalidatedRpcRequestPort } from '../../../../transport/rpc/unvalidated-rpc-request-port'
import {
  UNCONFIRMED_SEND_MESSAGE,
  UNCONFIRMED_SEND_RESTORED_MESSAGE
} from '../delivery/use-mobile-native-chat-unconfirmed-sends'
import type { AgentJournalCursor } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { loadMobileNativeChatDrafts } from './mobile-native-chat-draft-persistence'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import {
  confirmMobileRecordedRecovery,
  settleMobileInstructionRecovery
} from '../mobile-native-chat-recovery-delivery'
import type { AgentJournalSubmission } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../../../src/shared/agent-session/requests/agent-session-queued-message-wire'
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' }
}))

vi.mock('@react-native-async-storage/async-storage', async () => {
  const { createInMemoryAsyncStorage } =
    await import('../../../../test-support/in-memory-async-storage')
  return { default: createInMemoryAsyncStorage() }
})

const instructionTimeout = {
  kind: 'startFailed' as const,
  instructionRecovery: 'timeout' as const,
  neverReachedAgent: true as const
}

type DraftState = ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }

describe('mobile native-chat draft store', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null
  let structured: MobileStructuredSends
  const sendError = vi.fn()
  const emptySubmissions: readonly AgentJournalSubmission[] = []

  afterEach(async () => {
    act(() => renderer?.unmount())
    await loadMobileNativeChatDrafts('host', 'worktree')
    closeMobileNativeChatTabDraft('host\0worktree\0a')
    closeMobileNativeChatTabDraft('host\0worktree\0b')
    await loadMobileNativeChatDrafts('host', 'worktree')
    renderer = null
    state = null
    sendError.mockClear()
  })

  function Harness({
    tabId,
    submissions = emptySubmissions,
    cursor,
    connected = true,
    confirmRecorded,
    lookup,
    afterLayout,
    queuedMessages = null
  }: {
    tabId: string
    submissions?: readonly AgentJournalSubmission[]
    cursor?: AgentJournalCursor
    connected?: boolean
    confirmRecorded?: MobileStructuredSendConfirmation
    lookup?: { client: UnvalidatedRpcRequestPort; capabilities: readonly string[] }
    afterLayout?: () => void
    queuedMessages?: readonly AgentSessionQueuedMessage[] | null
  }): null {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: [],
      transcriptSettled: true
    })
    state = { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) }
    const confirmFromHost = useMobileStructuredSendRecorded(
      lookup?.client ?? null,
      `session-${tabId}`,
      lookup ? structuredAgentSessionHostSupport(lookup.capabilities) : null
    )
    structured = useMobileStructuredSends({
      sessionKey: `session-${tabId}`,
      sessionId: `session-${tabId}`,
      submissions,
      cursor,
      queuedMessages,
      draftScope: drafts.draftKey,
      onSendError: sendError,
      connected,
      confirmRecorded: confirmRecorded ?? confirmFromHost
    })
    useLayoutEffect(() => {
      afterLayout?.()
    }, [afterLayout])
    return null
  }

  function currentState(): DraftState {
    if (!state) {
      throw new Error('chat draft harness is not mounted')
    }
    return state
  }

  function sendOrigin(text: string): NonNullable<ReturnType<DraftState['captureSendOrigin']>> {
    const origin = currentState().captureSendOrigin(text)
    if (!origin) {
      throw new Error('chat draft has no send origin')
    }
    return origin
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('lets the original chat reclaim a saved send when its deadline fires during a tab switch', async () => {
    vi.useFakeTimers()
    try {
      await mount('a')
      const text = 'retained task'
      act(() => currentState().setComposerText(text))
      const origin = sendOrigin(text)
      const id = beginMobileNativeChatInFlightSend(origin, 'structured', text, {
        clientMessageId: 'recovery-task'
      })!
      act(() => currentState().clearDraftForSend(origin, text))
      act(() => structured.holdUnconfirmed('recovery-task', () => {}))

      act(() => {
        renderer!.update(
          createElement(Harness, { tabId: 'b', afterLayout: () => vi.advanceTimersByTime(20_000) })
        )
      })
      const confirmRecorded = async (): Promise<MobileStructuredSendRecord> => ({ recorded: false })
      act(() => renderer!.update(createElement(Harness, { tabId: 'a', confirmRecorded })))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(readMobileNativeChatInFlightSend(id)?.send).toMatchObject({
        text,
        deliveryUnconfirmed: true
      })
      expect(currentState().composerText).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['rejected', 'stale', 'accepted', 'unknown'] as const)(
    'settles a recorded pending task as %s without replaying or restoring accepted/unknown work',
    async (state) => {
      await mount('a')
      act(() => currentState().setComposerText('retained task'))
      const origin = sendOrigin('retained task')
      act(() => currentState().clearDraftForSend(origin, 'retained task'))
      const inFlightId = beginMobileNativeChatInFlightSend(origin, 'structured', 'retained task', {
        clientMessageId: 'recovery-task'
      })!
      const submission: AgentJournalSubmission = {
        clientMessageId: 'recovery-task',
        fence: 1,
        payloadFingerprint: 'task',
        dispatchState: 'pending',
        providerItemId: null,
        submittedAt: 1,
        resolvedAt: null,
        reason: null
      }
      const error = vi.fn()
      act(() => {
        settleMobileInstructionRecovery('session-a', [submission], error, [])
      })
      expect(currentState().composerText).toBe('')
      const settled = {
        ...submission,
        dispatchState: state === 'stale' ? ('rejected' as const) : state,
        ...(state === 'rejected' || state === 'stale'
          ? { keptAsQueuedMessageId: 'retained-card' }
          : {}),
        rejection: instructionTimeout
      }
      const cardIds = state === 'rejected' ? ['retained-card'] : []
      act(() => {
        settleMobileInstructionRecovery('session-a', [settled], error, cardIds)
      })
      act(() => {
        settleMobileInstructionRecovery('session-a', [settled], error, cardIds)
      })
      expect(currentState().composerText).toBe('')
      expect(readMobileNativeChatInFlightSend(inFlightId) !== null).toBe(
        state === 'unknown' || state === 'stale'
      )
      expect(error.mock.calls).toEqual(
        state === 'rejected' ? [[expect.any(String), { announceOnly: true }]] : []
      )
    }
  )

  it.each([false, true])(
    'keeps a saved send after a negative lookup, journal evidence paged out: %s',
    async (pagedOut) => {
      await mount('a')
      act(() => currentState().setComposerText('retained task'))
      const origin = sendOrigin('retained task')
      act(() => currentState().clearDraftForSend(origin, 'retained task'))
      const id = beginMobileNativeChatInFlightSend(origin, 'structured', 'retained task', {
        clientMessageId: 'recovery-task'
      })!
      const reply = Promise.withResolvers<MobileStructuredSendRecord>()
      let submissions: readonly AgentJournalSubmission[] = []
      confirmMobileRecordedRecovery({
        confirm: () => reply.promise,
        clientMessageId: 'recovery-task',
        inFlightIds: () => [id],
        handBack: () => returnMobileNativeChatInFlightSend(id),
        checked: new Map(),
        forgetLocalEcho: () => {},
        readDelivery: () => ({ submissions, queuedMessageIds: [] }),
        sessionId: 'session-a',
        onSendError: sendError
      })
      submissions = [
        {
          clientMessageId: 'recovery-task',
          fence: 1,
          payloadFingerprint: 'task',
          dispatchState: 'pending',
          providerItemId: null,
          submittedAt: 1,
          resolvedAt: null,
          reason: null
        }
      ]
      if (pagedOut) {
        settleMobileInstructionRecovery('session-a', submissions, sendError, [])
        submissions = []
      }
      await act(async () => reply.resolve({ recorded: false, confirmedAbsent: true }))
      expect(currentState().composerText).toBe('')
      expect(readMobileNativeChatInFlightSend(id)?.send).toMatchObject({
        text: 'retained task',
        deliveryUnconfirmed: true
      })
    }
  )

  it.each([
    'unavailable',
    'legacy',
    'unadvertised',
    'transport error',
    'unreadable',
    'absent'
  ] as const)(
    'makes one custody decision for a send outside the loaded page: %s',
    async (verdict) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        await mount('a')
        act(() => currentState().setComposerText('task outside the loaded page'))
        const origin = sendOrigin('task outside the loaded page')
        const id = beginMobileNativeChatInFlightSend(
          origin,
          'structured',
          'task outside the loaded page',
          { clientMessageId: 'outside-page' }
        )!
        act(() => currentState().clearDraftForSend(origin, 'task outside the loaded page'))
        const sendRequest = vi.fn<UnvalidatedRpcRequestPort['sendRequest']>(async () => {
          if (verdict === 'transport error') {
            throw new Error('connection lost')
          }
          return {
            id: 'send-lookup',
            ok: true,
            result: {
              recorded: false,
              ...(verdict === 'legacy' ? {} : { confirmedAbsent: true }),
              ...(verdict === 'unreadable'
                ? { submission: { clientMessageId: 'outside-page', dispatchState: 'invalid' } }
                : {})
            }
          }
        })
        const capabilities = verdict === 'unavailable' ? [] : ['agent-session.send-recorded.v1']
        if (verdict === 'absent' || verdict === 'transport error' || verdict === 'unreadable') {
          capabilities.push('agent-session.send-recorded-absence.v1')
        }
        act(() => {
          renderer!.update(
            createElement(Harness, {
              tabId: 'a',
              lookup: { client: { sendRequest }, capabilities }
            })
          )
          releaseMobileNativeChatInFlightSends([id])
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000)
        })
        expect(sendRequest).toHaveBeenCalledTimes(verdict === 'unavailable' ? 0 : 1)
        if (verdict === 'absent') {
          expect(currentState().composerText).toBe('task outside the loaded page')
          expect(readMobileNativeChatInFlightSend(id)).toBeNull()
          expect(sendError.mock.calls).toEqual([[UNCONFIRMED_SEND_RESTORED_MESSAGE]])
        } else {
          expect(currentState().composerText).toBe('')
          expect(readMobileNativeChatInFlightSend(id)?.send).toMatchObject({
            text: 'task outside the loaded page',
            deliveryUnconfirmed: true
          })
          expect(sendError.mock.calls).toEqual([[UNCONFIRMED_SEND_MESSAGE]])
        }
        if (verdict === 'unavailable') {
          act(() =>
            renderer!.update(
              createElement(Harness, {
                tabId: 'a',
                lookup: {
                  client: { sendRequest },
                  capabilities: ['agent-session.send-recorded-absence.v1']
                }
              })
            )
          )
          await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000)
          })
          expect(sendRequest).toHaveBeenCalledTimes(1)
          expect(currentState().composerText).toBe('task outside the loaded page')
          expect(readMobileNativeChatInFlightSend(id)).toBeNull()
        }
        if (verdict === 'legacy') {
          const capable = [...capabilities, 'agent-session.send-recorded-absence.v1']
          act(() => renderer!.update(createElement(Harness, { tabId: 'b' })))
          act(() =>
            renderer!.update(
              createElement(Harness, {
                tabId: 'a',
                lookup: { client: { sendRequest }, capabilities }
              })
            )
          )
          await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000)
          })
          expect(sendRequest).toHaveBeenCalledTimes(2)
          expect(sendError.mock.calls).toEqual([[UNCONFIRMED_SEND_MESSAGE]])
          sendRequest.mockResolvedValueOnce({
            id: 'send-recheck',
            ok: true,
            result: { recorded: false, confirmedAbsent: true }
          })
          act(() => renderer!.update(createElement(Harness, { tabId: 'b' })))
          act(() =>
            renderer!.update(
              createElement(Harness, {
                tabId: 'a',
                lookup: { client: { sendRequest }, capabilities: capable }
              })
            )
          )
          await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000)
          })
          expect(sendRequest).toHaveBeenCalledTimes(3)
          expect(currentState().composerText).toBe('task outside the loaded page')
          expect(readMobileNativeChatInFlightSend(id)).toBeNull()
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each([false, true])(
    'keeps a connected covering-page omission through reopen and late rejection, newer input: %s',
    async (newer) => {
      await mount('a')
      act(() => currentState().setComposerText('retained paged task'))
      let origin = sendOrigin('retained paged task')
      const file = {
        id: 'file-1',
        name: 'notes.txt',
        mime: 'text/plain',
        byteLength: 7,
        path: '/scratch/notes.txt'
      }
      act(() =>
        updateMobileNativeChatDraftInputs(origin.draftDestination, (inputs) => ({
          ...inputs,
          files: [file],
          skills: [{ name: 'review', path: '/scratch/SKILL.md' }]
        }))
      )
      origin = sendOrigin('retained paged task')
      const id = beginMobileNativeChatInFlightSend(origin, 'structured', 'retained paged task', {
        clientMessageId: 'paged-task',
        intent: { carried: { images: [], files: [file] } }
      })!
      act(() => {
        currentState().clearDraftForSend(origin, 'retained paged task')
        structured.accept({
          clientMessageId: 'paged-task',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'retained paged task' }]
          },
          queuedAt: 1,
          recordedCursor: { epoch: 'page-epoch', sequence: 10 }
        })
      })
      act(() =>
        renderer!.update(
          createElement(Harness, {
            tabId: 'a',
            cursor: { epoch: 'page-epoch', sequence: 100 },
            submissions: []
          })
        )
      )
      expect(structured.optimistic).toEqual([])
      expect(readMobileNativeChatInFlightSend(id)?.send).toMatchObject({
        text: 'retained paged task',
        files: [{ name: 'notes.txt', path: '/scratch/notes.txt' }],
        skills: [{ name: 'review', path: '/scratch/SKILL.md' }]
      })
      act(() => renderer?.unmount())
      await loadMobileNativeChatDrafts('host', 'worktree')
      await mount('a')
      if (newer) {
        act(() => currentState().setComposerText('new draft'))
      }
      const rejected: AgentJournalSubmission = {
        clientMessageId: 'paged-task',
        fence: 1,
        payloadFingerprint: 'paged',
        dispatchState: 'rejected',
        providerItemId: null,
        submittedAt: 1,
        resolvedAt: 5,
        reason: null,
        rejection: instructionTimeout,
        keptAsQueuedMessageId: 'paged-task'
      }
      act(() => renderer!.update(createElement(Harness, { tabId: 'a', submissions: [rejected] })))
      expect(currentState().composerText).toBe(newer ? 'new draft' : '')
      expect(readMobileNativeChatInFlightSend(id)?.send.files).toHaveLength(1)
      expect(readMobileNativeChatDraftInputs(origin.draftDestination.scope).files).toEqual([file])
      const returned: AgentSessionQueuedMessage = {
        messageId: 'paged-task',
        position: 0,
        state: 'returned',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'retained paged task' }]
        }
      }
      act(() =>
        renderer!.update(
          createElement(Harness, {
            tabId: 'a',
            submissions: [rejected],
            queuedMessages: [returned]
          })
        )
      )
      expect(readMobileNativeChatDraftInputs(origin.draftDestination.scope).files).toEqual([])
      expect(readMobileNativeChatInFlightSend(id)).toBeNull()
    }
  )

  it.each(['accepted', 'unknown'] as const)(
    'does not restore a paged send after correlated %s',
    async (outcome) => {
      await mount('a')
      act(() => currentState().setComposerText('keep uncertain work out of composer'))
      const origin = sendOrigin('keep uncertain work out of composer')
      const id = beginMobileNativeChatInFlightSend(
        origin,
        'structured',
        'keep uncertain work out of composer',
        {
          clientMessageId: 'terminal-task'
        }
      )!
      act(() => currentState().clearDraftForSend(origin, 'keep uncertain work out of composer'))
      act(() => {
        settleRecordedMobileNativeChatInFlightSends([id], [])
      })
      expect(readMobileNativeChatInFlightSend(id)).not.toBeNull()
      const submission: AgentJournalSubmission = {
        clientMessageId: 'terminal-task',
        fence: 1,
        payloadFingerprint: 'terminal',
        dispatchState: outcome,
        providerItemId: null,
        submittedAt: 1,
        resolvedAt: 5,
        reason: null
      }
      act(() => renderer!.update(createElement(Harness, { tabId: 'a', submissions: [submission] })))
      expect(currentState().composerText).toBe('')
      expect(Boolean(readMobileNativeChatInFlightSend(id))).toBe(outcome === 'unknown')
    }
  )

  it.each(['rejected', 'accepted', 'unknown', 'queued', 'recorded only'] as const)(
    'resolves a paged-out send as %s by correlated host lookup after offline/reopen',
    async (outcome) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        await mount('a')
        act(() => currentState().setComposerText('task outside the loaded page'))
        const origin = sendOrigin('task outside the loaded page')
        const id = beginMobileNativeChatInFlightSend(
          origin,
          'structured',
          'task outside the loaded page',
          { clientMessageId: 'outside-page' }
        )!
        act(() => currentState().clearDraftForSend(origin, 'task outside the loaded page'))
        const fact: AgentJournalSubmission = {
          clientMessageId: 'outside-page',
          fence: 1,
          payloadFingerprint: 'outside',
          dispatchState:
            outcome === 'queued' ? 'pending' : outcome === 'recorded only' ? 'unknown' : outcome,
          providerItemId: null,
          submittedAt: 1,
          resolvedAt: 5,
          reason: null,
          ...(outcome === 'rejected'
            ? {
                rejection: instructionTimeout,
                keptAsQueuedMessageId: 'outside-page'
              }
            : {})
        }
        const confirmRecorded = vi.fn(async (): Promise<MobileStructuredSendRecord> => ({
          recorded: true,
          ...(outcome === 'queued' || outcome === 'rejected' ? { ownedByQueue: true } : {}),
          ...(outcome === 'queued' || outcome === 'recorded only' ? {} : { submission: fact })
        }))
        act(() =>
          renderer!.update(
            createElement(Harness, { tabId: 'a', connected: false, confirmRecorded })
          )
        )
        act(() => releaseMobileNativeChatInFlightSends([id]))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000)
        })
        expect(confirmRecorded).not.toHaveBeenCalled()
        expect(currentState().composerText).toBe('')
        act(() => renderer!.unmount())
        await act(async () => {
          renderer = create(createElement(Harness, { tabId: 'a', confirmRecorded }))
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        expect(currentState().composerText).toBe('')
        expect(confirmRecorded).toHaveBeenCalledTimes(1)
        if (outcome === 'unknown' || outcome === 'recorded only') {
          expect(readMobileNativeChatInFlightSend(id)?.send.text).toBe(
            'task outside the loaded page'
          )
          expect(structured.optimistic.map(({ retainedSendId }) => retainedSendId)).toEqual([id])
        } else {
          expect(readMobileNativeChatInFlightSend(id)).toBeNull()
          expect(structured.optimistic).toEqual([])
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(['absent', 'transport error'] as const)(
    'keeps a replaced lookup’s %s result from changing newer custody',
    async (reply) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        await mount('a')
        const text = 'saved across views'
        act(() => currentState().setComposerText(text))
        const origin = sendOrigin(text)
        const id = beginMobileNativeChatInFlightSend(origin, 'structured', text, {
          clientMessageId: 'saved-across-views'
        })!
        const old = Promise.withResolvers<MobileStructuredSendRecord>()
        const confirmOld = vi.fn(() => old.promise)
        act(() => {
          currentState().clearDraftForSend(origin, text)
          renderer!.update(createElement(Harness, { tabId: 'a', confirmRecorded: confirmOld }))
          releaseMobileNativeChatInFlightSends([id])
        })
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        expect(confirmOld).toHaveBeenCalledTimes(1)
        act(() => renderer!.unmount())
        const pending: AgentJournalSubmission = {
          clientMessageId: 'saved-across-views',
          fence: 1,
          payloadFingerprint: 'saved',
          dispatchState: 'pending',
          providerItemId: null,
          submittedAt: 1,
          resolvedAt: null,
          reason: null
        }
        const confirmCurrent = vi.fn(async (): Promise<MobileStructuredSendRecord> => ({
          recorded: true,
          submission: { ...pending, dispatchState: 'accepted' }
        }))
        await act(async () => {
          renderer = create(
            createElement(Harness, {
              tabId: 'a',
              submissions: [pending],
              confirmRecorded: confirmCurrent
            })
          )
        })
        await act(async () => {
          if (reply === 'absent') {
            old.resolve({ recorded: false, confirmedAbsent: true })
          } else {
            old.reject(new Error('connection lost'))
          }
        })
        expect(currentState().composerText).toBe('')
        expect(readMobileNativeChatInFlightSend(id)).not.toBeNull()
        expect(readMobileNativeChatInFlightSend(id)?.send.deliveryUnconfirmed).toBeUndefined()
        expect(sendError).not.toHaveBeenCalled()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        expect(confirmCurrent).toHaveBeenCalledTimes(1)
        expect(readMobileNativeChatInFlightSend(id)).toBeNull()
        expect(currentState().composerText).toBe('')
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each(['pending', 'covered'] as const)(
    'keeps a saved lookup alive when %s evidence can only retire the optimistic echo',
    async (evidence) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        await mount('a')
        const text = 'send across a bounded page'
        act(() => currentState().setComposerText(text))
        const origin = sendOrigin(text)
        const id = beginMobileNativeChatInFlightSend(origin, 'structured', text, {
          clientMessageId: 'saved-send'
        })!
        const submission = {
          clientMessageId: 'saved-send',
          fence: 1,
          payloadFingerprint: 'saved',
          providerItemId: null,
          submittedAt: 1,
          resolvedAt: null,
          reason: null
        }
        const confirmRecorded = vi.fn(async (): Promise<MobileStructuredSendRecord> => ({
          recorded: true,
          submission: { ...submission, dispatchState: 'accepted' }
        }))
        act(() => {
          currentState().clearDraftForSend(origin, text)
          structured.accept({
            clientMessageId: 'saved-send',
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
            queuedAt: null,
            recordedCursor: { epoch: 'page', sequence: 10 }
          })
          renderer!.update(
            createElement(Harness, {
              tabId: 'a',
              confirmRecorded,
              ...(evidence === 'covered'
                ? { cursor: { epoch: 'page', sequence: 20 } }
                : { submissions: [{ ...submission, dispatchState: 'pending' }] })
            })
          )
          releaseMobileNativeChatInFlightSends([id])
        })
        expect(readMobileNativeChatInFlightSend(id)).not.toBeNull()
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        expect(confirmRecorded.mock.calls).toEqual([['saved-send']])
        expect(readMobileNativeChatInFlightSend(id)).toBeNull()
        expect(currentState().composerText).toBe('')
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('settles a retained send to its returned card when the linking submission is off-page', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      await mount('a')
      const text = 'keep this until the card comes back'
      act(() => currentState().setComposerText(text))
      const origin = sendOrigin(text)
      const id = beginMobileNativeChatInFlightSend(origin, 'structured', text, {
        clientMessageId: 'original-attempt'
      })!
      act(() => {
        currentState().clearDraftForSend(origin, text)
        releaseMobileNativeChatInFlightSends([id])
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(structured.optimistic.map(({ retainedSendId }) => retainedSendId)).toEqual([id])
      const returned: AgentSessionQueuedMessage = {
        messageId: 'linked-card',
        returnedFromClientMessageId: 'original-attempt',
        position: 0,
        state: 'returned',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
      }
      act(() =>
        renderer!.update(createElement(Harness, { tabId: 'a', queuedMessages: [returned] }))
      )
      expect(structured.optimistic).toEqual([])
      expect(readMobileNativeChatInFlightSend(id)).toBeNull()
      expect(currentState().composerText).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reclaims a legacy saved structured send using its fallback key after reopening', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      await mount('a')
      const text = 'legacy retained text'
      act(() => currentState().setComposerText(text))
      const origin = sendOrigin(text)
      const id = beginMobileNativeChatInFlightSend(origin, 'structured', text)!
      act(() => {
        currentState().clearDraftForSend(origin, text)
        releaseMobileNativeChatInFlightSends([id])
      })
      act(() => renderer!.unmount())
      const confirmRecorded = vi.fn(async () => ({ recorded: false }))
      await act(async () => {
        renderer = create(createElement(Harness, { tabId: 'a', confirmRecorded }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(confirmRecorded.mock.calls).toEqual([[id]])
      expect(structured.optimistic.map(({ retainedSendId }) => retainedSendId)).toEqual([id])
      expect(currentState().composerText).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})
