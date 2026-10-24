import { expect, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  hostTestState,
  attach,
  envelope,
  CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { observeStructuredAttentionWork } from './structured-attention-work.test-fixture'
export { assertSnapshotCosts } from './structured-attention-work.test-fixture'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { insertCommandReceiptIfAbsent } from '../native-chat/agent-session-journal/command-receipt-table'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'
import {
  createStructuredAttentionMobileDelivery,
  subscribeStructuredAgentSessionAttention
} from './structured-agent-session-mobile-attention'
import {
  countAttentionCollectionWork,
  isAttentionReplay
} from './attention-operation-count.test-fixture'
import { attentionDeliveryTail } from './attention-delivery-tail.test-fixture'
import { authenticatedDesktopSockets } from './rpc/mobile-socket-wiring.test-fixture'

export async function structuredAttentionScaling(
  options: {
    items?: number
    submissions?: number
    subscribers?: number
    sockets?: number
    capabilities?: number
  } = {}
) {
  const h = hostTestState()
  await attach()
  const journal = h.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const fence = h.store.getRecord(SESSION)!.lease.runtimeFence
  const initialSubmissions = options.submissions ?? 2
  for (let index = 0; index < initialSubmissions - 1; index += 1) {
    const clientMessageId = `historical-${index}`
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: clientMessageId,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'history' }] },
      fence
    })
    await journal.resolveDispatch({
      clientMessageId,
      state: 'accepted',
      providerIdentity: null,
      fence
    })
  }
  const missing = (options.items ?? 20) - journal.snapshot().items.length - 1
  if (missing > 0) {
    await journal.appendLifecycleBatch({
      settlementId: 'performance-history',
      fence,
      mutations: Array.from({ length: missing }, (_, index) => ({
        kind: 'item' as const,
        identity: {
          provider: 'codex' as const,
          threadId: THREAD,
          turnId: 'history',
          ordinal: index
        },
        body: {
          kind: 'message' as const,
          role: 'assistant' as const,
          blocks: [{ type: 'text' as const, text: 'history' }]
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }))
    })
  }
  const controller = new RuntimeMobileNotificationController()
  const tail = attentionDeliveryTail(controller, h.root)
  const socket = await authenticatedDesktopSockets(
    CALLER.callerKey,
    options.sockets ?? 8,
    options.capabilities ?? 2
  )
  const proof: { filter: number; membership: number; result: boolean }[] = []
  const retirements: number[] = []
  let starts = 0
  subscribeStructuredAgentSessionAttention(
    h.host,
    createStructuredAttentionMobileDelivery({
      readNotificationSettings: () => ({
        enabled: true,
        agentTaskComplete: true,
        terminalBell: true,
        suppressWhenFocused: false,
        customSoundId: 'system',
        customSoundPath: null,
        customSoundVolume: 1,
        mutedNotificationSourceIds: [],
        notifyHiddenWorkspaces: true
      }),
      readWorkspaceLabels: () => ({}),
      isWorkspaceMuted: () => false,
      isConnectedDesktop: (id) => {
        const { counts, result } = countAttentionCollectionWork(() =>
          socket.wiring.isConnectedDesktop(id)
        )
        proof.push({ filter: counts.filter, membership: counts.membership, result })
        return result
      },
      dispatch: (event) => controller.dispatch(event),
      reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
      onTurnStarted: (id, cursor, floor) => {
        starts += 1
        const { counts } = countAttentionCollectionWork(
          () => controller.retireLiveStructuredTurn(id, cursor, floor),
          isAttentionReplay
        )
        retirements.push(counts.callbacks)
      },
      now: Date.now
    })
  )
  for (let index = 1; index < (options.subscribers ?? 2); index += 1) {
    h.host.subscribeTurnCompletions({
      id: `scaling-${index}`,
      emit: () => {},
      onTurnStarted: () => {
        starts += 1
      }
    })
  }
  const work = observeStructuredAttentionWork(h.host, journal, h.store)
  const { snapshots, provenance } = work
  const events = h.acquire.mock.calls.at(-1)![0].events!
  const send = async (text: string) => {
    const body = hostTestMessage(text)
    const command = envelope('agentSession.send', { body })
    expect(await h.host.send(CALLER, { envelope: command, body })).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(journal.submission(command.clientOperationId)?.dispatchState).toBe('accepted')
    )
    return command.clientOperationId
  }
  const writeTurn = async (id: string, operation: string, state: 'running' | 'completed') => {
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: id, ordinal: 0 }
    events.appendItem(
      identity,
      {
        kind: 'turn',
        turnId: id,
        state,
        userItemId: agentJournalSubmissionKey(operation),
        ...(state === 'completed' ? { outcome: 'success' as const } : {})
      },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
    )
    await h.host.flushStreamedEvents(SESSION)
  }
  const prompt = async (id: number, turnId: string, resolved = false) => {
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId, ordinal: id + 10 },
      {
        kind: 'approval',
        title: 'Allow?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: resolved
          ? {
              state: 'resolved',
              selectedOptionId: 'yes',
              resolvedBy: 'fixture',
              resolvedAt: Date.now()
            }
          : { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      {
        turnScope: {
          kind: 'turn',
          turnItemId: agentJournalItemKey({
            provider: 'codex',
            threadId: THREAD,
            turnId,
            ordinal: 0
          })
        }
      }
    )
    await h.host.flushStreamedEvents(SESSION)
  }
  const addCandidate = (operation: string, caller: string, matches: boolean) => {
    const submittedSequence = journal.submission(operation)?.submittedSequence
    if (submittedSequence === undefined) {
      throw new Error('Expected a submitted journal sequence for the receipt candidate')
    }
    openTestJournalHostDatabase(h.root).transaction((db) => {
      expect(
        insertCommandReceiptIfAbsent(
          db,
          { kind: 'caller', callerKey: caller },
          {
            operationId: operation,
            sessionId: SESSION,
            callerKey: caller,
            method: 'agentSession.send',
            fingerprint: `${caller}-fingerprint`,
            status: 'accepted',
            acceptedAt: Date.now(),
            result: {
              kind: 'journal-row',
              epoch: journal.cursor().epoch,
              sequence: submittedSequence + (matches ? 0 : 1)
            }
          }
        )
      ).toEqual({ inserted: true })
    })
  }
  const reset = () => {
    work.reset()
    proof.length = 0
    starts = 0
    retirements.length = 0
  }
  return {
    h,
    journal,
    controller,
    tail,
    socket,
    proof,
    snapshots,
    provenance,
    retirements,
    starts: () => starts,
    send,
    writeTurn,
    prompt,
    addCandidate,
    reset,
    async close() {
      socket.close()
      await tail.close()
      vi.restoreAllMocks()
    }
  }
}
