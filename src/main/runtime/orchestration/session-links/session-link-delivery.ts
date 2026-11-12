import { sessionLinkNextMessage } from '../../../../shared/session-link-wait'
import { sessionLinkMessageBody } from './session-link-message'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { sendAgentTurn } from '../turn-delivery/send-agent-turn'
import type { OrchestrationDb } from '../db/orchestration-db'
import { conversationRecordReader } from '../addressing/session-lineage/structured-session-lineage'
import { structuredSessionMailReach } from '../mailbox/routing/structured-session-mail-address'
import { structuredSessionGateFacts } from '../mailbox/structured-pointer/structured-session-pointer-delivery'
import { SessionLinkStore } from './session-link-store'

const flights = new WeakMap<OrchestrationDb, { running: Set<string>; dirty: Set<string> }>()

export function scheduleSessionLinkDelivery(
  db: OrchestrationDb | null | undefined,
  sessionId?: string
): void {
  if (db) {
    void redriveSessionLinks(db, sessionId).catch((error) =>
      console.warn('[session-link] redrive unavailable', error)
    )
  }
}

export async function redriveSessionLinks(db: OrchestrationDb, sessionId?: string): Promise<void> {
  const jobs: Promise<void>[] = []
  const store = new SessionLinkStore(db)
  const flight = flights.get(db) ?? { running: new Set<string>(), dirty: new Set<string>() }
  flights.set(db, flight)
  for (const link of store.pending(sessionId)) {
    for (const participant of link.participants) {
      if (sessionId && sessionId !== participant.sessionId) {
        continue
      }
      if (flight.running.has(participant.sessionId)) {
        flight.dirty.add(participant.sessionId)
        continue
      }
      flight.running.add(participant.sessionId)
      const job = deliverNext(store, link.id, participant.sessionId)
        .catch((error) => {
          console.warn(
            '[session-link] delivery retained',
            error instanceof Error ? error.message : String(error)
          )
        })
        .finally(() => {
          flight.running.delete(participant.sessionId)
          if (flight.dirty.delete(participant.sessionId)) {
            void redriveSessionLinks(db, participant.sessionId).catch(() => {})
          }
        })
      jobs.push(job)
    }
  }
  return Promise.all(jobs).then(() => {})
}

async function deliverNext(
  store: SessionLinkStore,
  linkId: string,
  sessionId: string
): Promise<void> {
  const event = sessionLinkNextMessage(store.events(linkId), sessionId)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const link = store.get(linkId)
  const participant = link.participants.find((p) => p.sessionId === sessionId)
  const record = host.deps.store.getConversation(sessionId)
  const visible = host.deps.store.getVisibleSessionTabIndex()
  const reach =
    record &&
    structuredSessionMailReach(
      conversationRecordReader(host.deps.store),
      record,
      store.orchestration
    )
  if (
    !visible.present ||
    !visible.sessionIds.includes(sessionId) ||
    !participant ||
    !record ||
    reach?.kind !== 'reachable' ||
    reach.session.sessionId !== sessionId ||
    record.location.workspaceId !== participant.workspaceId ||
    (record.providerContextBoundary?.operationId ?? '') !== participant.context
  ) {
    store.pause(linkId, 'participant-changed')
    if (!event || !['dispatching', 'blocked'].includes(event.state) || !record) {
      return
    }
  }
  if (!event || !record) {
    return
  }
  const snapshot = await host.journalSnapshot(sessionId)
  const work = host.currentWork(sessionId)
  const gates = structuredSessionGateFacts(snapshot.items, work?.scope)
  if (event.state === 'dispatching' || (event.state === 'blocked' && event.retryable === false)) {
    const direct = snapshot.submissions.find((s) => s.clientMessageId === event.operationId)
    const answer = direct ? null : await host.queuedSendAnswer(sessionId, event.operationId)
    if (store.event(event.id)?.state === 'cancelled') {
      return
    }
    if (answer && 'queued' in answer) {
      if (answer.queued.state === 'withdrawn') {
        store.write({
          ...event,
          state: 'cancelled',
          detail: 'The queued message was removed in the recipient chat.'
        })
      }
      return
    }
    const previous = direct ?? (answer && 'submission' in answer ? answer.submission : undefined)
    if (previous?.dispatchState === 'accepted') {
      store.write({ ...event, state: 'accepted', detail: '' })
    } else if (previous?.dispatchState === 'rejected' || previous?.dispatchState === 'unknown') {
      store.write({
        ...event,
        state: 'blocked',
        retryable: previous.dispatchState === 'rejected',
        detail: previous.reason ?? 'Delivery needs owner review.'
      })
      store.pause(
        linkId,
        previous.dispatchState === 'rejected' ? 'delivery-refused' : 'delivery-unknown'
      )
    } else if (!previous) {
      store.write({
        ...event,
        state: 'blocked',
        retryable: false,
        detail: 'Delivery outcome is unknown. Check the chat; this operation will not be resent.'
      })
      store.pause(linkId, 'delivery-unknown')
    }
    // A crash can occur after an external effect but before its receipt: never mint another operation here.
    return
  }
  if (
    link.state !== 'active' ||
    event.state === 'blocked' ||
    gates.awaitingHuman ||
    gates.turnRunning ||
    work?.working()
  ) {
    return
  }
  if (!host.canAdmitBackgroundMessage(sessionId)) {
    return
  }
  const reserved = store.reserve(linkId, event.id)
  if (!reserved) {
    return
  }
  let held = false
  try {
    const outcome = await sendAgentTurn({
      kind: 'structured-session',
      host,
      sessionId,
      callerKey: `trusted-local:session-link:${linkId}`,
      turn: {
        body: sessionLinkMessageBody(link, reserved),
        operationId: reserved.operationId,
        expectedRuntimeFence: record.currentFence,
        delivery: 'now',
        beforeRun: () => {
          const current = store.get(linkId)
          const currentVisible = host.deps.store.getVisibleSessionTabIndex()
          const currentRecord = host.deps.store.getConversation(sessionId)
          const currentReach =
            currentRecord &&
            structuredSessionMailReach(
              conversationRecordReader(host.deps.store),
              currentRecord,
              store.orchestration
            )
          if (
            !currentVisible.present ||
            !currentVisible.sessionIds.includes(sessionId) ||
            !currentRecord ||
            currentRecord.location.workspaceId !== participant?.workspaceId ||
            (currentRecord.providerContextBoundary?.operationId ?? '') !== participant?.context ||
            currentReach?.kind !== 'reachable' ||
            currentReach.session.sessionId !== sessionId ||
            current.state !== 'active' ||
            current.version !== link.version ||
            !host.canAdmitBackgroundMessage(sessionId, reserved.operationId)
          ) {
            held = true
            throw new Error('Session link delivery held before dispatch.')
          }
        }
      }
    })
    if (outcome.kind === 'refused') {
      store.write({
        ...reserved,
        state: 'blocked',
        retryable: true,
        detail: outcome.refusal.message
      })
      store.pause(linkId, 'delivery-refused')
    } else if (outcome.kind === 'queued') {
      // The host owns this ID; the journal edge reconciles its eventual outcome.
      store.write({ ...reserved, detail: 'Accepted by the session queue.' })
    } else if (outcome.submission?.dispatchState === 'accepted') {
      store.write({ ...reserved, state: 'accepted', detail: '' })
    } else if (outcome.submission?.dispatchState === 'rejected') {
      store.write({
        ...reserved,
        state: 'blocked',
        retryable: true,
        detail: outcome.submission.reason ?? 'Agent refused delivery.'
      })
      store.pause(linkId, 'delivery-refused')
    }
  } catch (error) {
    if (!held) {
      throw error
    }
    store.write({
      ...reserved,
      state: 'blocked',
      retryable: true,
      detail: 'Delivery held before dispatch.'
    })
    store.pause(linkId, 'delivery-held')
  }
}
