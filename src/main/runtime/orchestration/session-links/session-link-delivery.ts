import { sessionLinkNextMessage } from '../../../../shared/session-link-wait'
import { sessionLinkMessageBody } from './session-link-message'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { canAdmitBackgroundMessage } from '../../../native-chat/agent-session-wire/structured-agent-session-background-message'
import { sendAgentTurn } from '../turn-delivery/send-agent-turn'
import type { OrchestrationDb } from '../db/orchestration-db'
import { conversationRecordReader } from '../addressing/session-lineage/structured-session-lineage'
import { structuredSessionMailReach } from '../mailbox/routing/structured-session-mail-address'
import { sessionLinks } from './worker/session-link-worker-client'
import type { SessionLinks } from './worker/session-link-worker-protocol'

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
  const links = sessionLinks(db)
  const flight = flights.get(db) ?? { running: new Set<string>(), dirty: new Set<string>() }
  flights.set(db, flight)
  for (const link of await links.pending(sessionId)) {
    for (const participant of link.participants) {
      if (sessionId && sessionId !== participant.sessionId) {
        continue
      }
      if (flight.running.has(participant.sessionId)) {
        flight.dirty.add(participant.sessionId)
        continue
      }
      flight.running.add(participant.sessionId)
      const job = deliverNext(db, links, link.id, participant.sessionId)
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
  db: OrchestrationDb,
  links: SessionLinks,
  linkId: string,
  sessionId: string
): Promise<void> {
  const event = sessionLinkNextMessage(await links.events(linkId), sessionId)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  const link = await links.get(linkId)
  const participant = link.participants.find((p) => p.sessionId === sessionId)
  const record = host.deps.store.getConversation(sessionId)
  const visible = host.deps.store.getVisibleSessionTabIndex()
  const reach =
    record && structuredSessionMailReach(conversationRecordReader(host.deps.store), record, db)
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
    await links.pause(linkId, 'participant-changed')
    if (!event || !['dispatching', 'blocked'].includes(event.state) || !record) {
      return
    }
  }
  if (!event || !record) {
    return
  }
  const work = await host.currentWorkAtRest(sessionId)
  if (event.state === 'dispatching' || (event.state === 'blocked' && event.retryable === false)) {
    const answer = await host.sendAnswer(sessionId, event.operationId)
    if ((await links.event(event.id))?.state === 'cancelled') {
      return
    }
    if (answer.kind === 'withdrawn') {
      await links.write({
        ...event,
        state: 'cancelled',
        detail: 'The queued message was removed in the recipient chat.'
      })
      return
    }
    if (answer.kind === 'waiting') {
      return
    }
    if (answer.kind === 'accepted') {
      await links.write({ ...event, state: 'accepted', detail: '' })
    } else if (answer.kind === 'rejected' || answer.kind === 'refused') {
      await links.write({
        ...event,
        state: 'blocked',
        retryable: true,
        detail: 'Agent refused delivery.'
      })
      await links.pause(linkId, 'delivery-refused')
    } else {
      await links.write({
        ...event,
        state: 'blocked',
        retryable: false,
        detail: 'Delivery outcome is unknown. Check the chat; this operation will not be resent.'
      })
      await links.pause(linkId, 'delivery-unknown')
    }
    // A crash can occur after an external effect but before its receipt: never mint another operation here.
    return
  }
  if (
    link.state !== 'active' ||
    event.state === 'blocked' ||
    work?.hasActionablePrompt() ||
    work?.activeTurnId() !== null ||
    work?.working()
  ) {
    return
  }
  if (!(await canAdmitBackgroundMessage(host, sessionId))) {
    return
  }
  const reserved = await links.reserve(linkId, event.id)
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
        beforeRun: async () => {
          const current = await links.get(linkId)
          const currentVisible = host.deps.store.getVisibleSessionTabIndex()
          const currentRecord = host.deps.store.getConversation(sessionId)
          const currentReach =
            currentRecord &&
            structuredSessionMailReach(conversationRecordReader(host.deps.store), currentRecord, db)
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
            !(await canAdmitBackgroundMessage(host, sessionId, reserved.operationId))
          ) {
            held = true
            throw new Error('Session link delivery held before dispatch.')
          }
        }
      }
    })
    if (outcome.kind === 'refused') {
      await links.write({
        ...reserved,
        state: 'blocked',
        retryable: true,
        detail: outcome.refusal.message
      })
      await links.pause(linkId, 'delivery-refused')
    } else if (outcome.kind === 'queued') {
      // The host owns this ID; the journal edge reconciles its eventual outcome.
      await links.write({ ...reserved, detail: 'Accepted by the session queue.' })
    } else if (outcome.submission?.dispatchState === 'accepted') {
      await links.write({ ...reserved, state: 'accepted', detail: '' })
    } else if (outcome.submission?.dispatchState === 'rejected') {
      await links.write({
        ...reserved,
        state: 'blocked',
        retryable: true,
        detail: outcome.submission.reason ?? 'Agent refused delivery.'
      })
      await links.pause(linkId, 'delivery-refused')
    }
  } catch (error) {
    if (!held) {
      throw error
    }
    await links.write({
      ...reserved,
      state: 'blocked',
      retryable: true,
      detail: 'Delivery held before dispatch.'
    })
    await links.pause(linkId, 'delivery-held')
  }
}
