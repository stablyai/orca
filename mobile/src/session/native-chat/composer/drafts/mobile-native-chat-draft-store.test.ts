import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  closeMobileNativeChatTabDraft,
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
import type { MobileStructuredSendRecord } from '../delivery/mobile-structured-send-recorded-read'
import type { AgentJournalCursor } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import { loadMobileNativeChatDrafts } from './mobile-native-chat-draft-persistence'
import {
  readMobileNativeChatDraftInputs,
  updateMobileNativeChatDraftInputs
} from './mobile-native-chat-draft-inputs'
import { settleMobileInstructionRecovery } from '../mobile-native-chat-recovery-delivery'
import type { AgentJournalSubmission } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
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
    confirmRecorded
  }: {
    tabId: string
    submissions?: readonly AgentJournalSubmission[]
    cursor?: AgentJournalCursor
    connected?: boolean
    confirmRecorded?: (id: string) => Promise<MobileStructuredSendRecord> | null
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
    structured = useMobileStructuredSends({
      sessionKey: `session-${tabId}`,
      sessionId: `session-${tabId}`,
      submissions,
      cursor,
      queuedMessages: null,
      onSendError: sendError,
      connected,
      confirmRecorded
    })
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

  it.each(['rejected', 'accepted', 'unknown'] as const)(
    'settles a recorded pending task as %s without replaying or restoring accepted/unknown work',
    async (state) => {
      await mount('a')
      act(() => currentState().setComposerText('retained task'))
      const origin = sendOrigin('retained task')
      act(() => currentState().clearDraftForSend(origin, 'retained task'))
      beginMobileNativeChatInFlightSend(origin, 'structured', 'retained task', {
        clientMessageId: 'recovery-task'
      })
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
      act(() => settleMobileInstructionRecovery('session-a', [submission], error))
      expect(currentState().composerText).toBe('')
      const settled = {
        ...submission,
        dispatchState: state,
        ...(state === 'rejected' ? { keptAsQueuedMessageId: 'retained-card' } : {}),
        rejection: instructionTimeout
      }
      act(() => settleMobileInstructionRecovery('session-a', [settled], error))
      act(() => settleMobileInstructionRecovery('session-a', [settled], error))
      expect(currentState().composerText).toBe('')
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
      expect(readMobileNativeChatDraftInputs(origin.draftDestination.scope).files).toEqual([])
      act(() => renderer!.update(createElement(Harness, { tabId: 'a', submissions: [rejected] })))
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
      act(() => settleRecordedMobileNativeChatInFlightSends([id], []))
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

  it.each(['rejected', 'accepted', 'unknown', 'queued'] as const)(
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
          dispatchState: outcome === 'queued' ? 'pending' : outcome,
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
          ...(outcome === 'queued' ? { ownedByQueue: true } : { submission: fact })
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
        expect(currentState().composerText).toBe('')
        act(() =>
          renderer!.update(createElement(Harness, { tabId: 'a', connected: true, confirmRecorded }))
        )
        await act(async () => {
          await vi.advanceTimersByTimeAsync(20_000)
        })
        expect(currentState().composerText).toBe('')
        expect(Boolean(readMobileNativeChatInFlightSend(id))).toBe(outcome === 'unknown')
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
