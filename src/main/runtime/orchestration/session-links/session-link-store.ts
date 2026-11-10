import { appendSessionLinkMessage, type SessionLinkAppend } from './session-link-message-store'
import { mintAgentSessionOperationId } from '../mailbox/structured-pointer/structured-pointer-operation-id'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  SessionLink,
  SessionLinkEvent,
  SESSION_LINK_TURN_LIMIT
} from '../../../../shared/session-link'
import type { OrchestrationDb } from '../db/orchestration-db'
import { runLifecycleWriteTransaction } from '../db/lifecycle-write-transaction-runner'

const storedDocument = z.object({ document: z.string() })
const storedId = z.object({ link_id: z.string() })

export class SessionLinkStore {
  constructor(readonly orchestration: OrchestrationDb) {}

  transaction<T>(operation: () => T): T {
    return runLifecycleWriteTransaction(this.orchestration.db, 'session_link_write', operation)
  }

  get(id: string): SessionLink {
    const row = this.orchestration.db
      .prepare('SELECT document FROM session_links WHERE id = ?')
      .get(id)
    if (!row) {
      throw new Error('Session link not found.')
    }
    return SessionLink.parse(JSON.parse(storedDocument.parse(row).document))
  }

  forSession(sessionId: string): SessionLink | null {
    const row = this.orchestration.db
      .prepare('SELECT link_id FROM session_link_participants WHERE session_id = ?')
      .get(sessionId)
    return row ? this.get(storedId.parse(row).link_id) : null
  }

  list(): SessionLink[] {
    return this.orchestration.db
      .prepare('SELECT document FROM session_links')
      .all()
      .map((row) => SessionLink.parse(JSON.parse(storedDocument.parse(row).document)))
  }

  pending(sessionId?: string): SessionLink[] {
    return this.orchestration.db
      .prepare(`SELECT document FROM session_links
      WHERE (json_extract(document, '$.state') = 'active' OR EXISTS (
        SELECT 1 FROM session_link_events e WHERE e.link_id = session_links.id
          AND json_extract(e.document, '$.messageId') IS NOT NULL
          AND (json_extract(e.document, '$.state') = 'dispatching' OR
            (json_extract(e.document, '$.state') = 'blocked' AND json_extract(e.document, '$.retryable') = 0))))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(document, '$.participants') p
        WHERE json_extract(p.value, '$.sessionId') = ?))`)
      .all(sessionId ?? null, sessionId ?? null)
      .map((row) => SessionLink.parse(JSON.parse(storedDocument.parse(row).document)))
  }

  pause(id: string, reason: string): void {
    this.transaction(() => {
      const link = this.get(id)
      if (link.state === 'ended' || (link.state === 'paused' && reason !== 'owner-decision')) {
        return
      }
      this.save({
        ...link,
        state: 'paused',
        reason,
        version: link.version + 1,
        updatedAt: Date.now()
      })
      this.write({
        id: randomUUID(),
        linkId: id,
        actor: 'host',
        recipient: null,
        kind: 'control',
        messageId: null,
        replyTo: null,
        state: 'recorded',
        operationId: '',
        createdAt: Date.now(),
        detail: reason,
        body: ''
      })
    })
  }

  save(link: SessionLink): void {
    const checked = SessionLink.parse(link)
    this.orchestration.db
      .prepare('UPDATE session_links SET document = ? WHERE id = ?')
      .run(JSON.stringify(checked), link.id)
  }

  create(
    id: string,
    story: string,
    participants: SessionLink['participants'],
    policy?: SessionLink['policy']
  ): SessionLink {
    return this.transaction(() => {
      const existing = this.orchestration.db
        .prepare('SELECT id FROM session_links WHERE id = ?')
        .get(id)
      if (existing) {
        const link = this.get(id)
        if (
          link.story !== story ||
          JSON.stringify(link.policy) !== JSON.stringify(policy) ||
          JSON.stringify(link.participants.map((p) => [p.sessionId, p.conversationId, p.role])) !==
            JSON.stringify(participants.map((p) => [p.sessionId, p.conversationId, p.role]))
        ) {
          throw new Error('This operation already created a different session link.')
        }
        return link
      }
      SessionLink.shape.participants.parse(participants)
      if (participants.some((p) => this.forSession(p.conversationId))) {
        throw new Error('A participant already has an active session link.')
      }
      const now = Date.now()
      const link = SessionLink.parse({
        id,
        story,
        participants,
        initialParticipantSessionIds: participants.map((p) => p.sessionId),
        ...(policy ? { policy } : {}),
        state: 'active',
        reason: '',
        version: 1,
        turns: 0,
        messages: 0,
        createdAt: now,
        updatedAt: now
      })
      this.orchestration.db
        .prepare('INSERT INTO session_links (id, document) VALUES (?, ?)')
        .run(id, JSON.stringify(link))
      for (const p of participants) {
        this.orchestration.db
          .prepare('INSERT INTO session_link_participants (session_id, link_id) VALUES (?, ?)')
          .run(p.conversationId, id)
      }
      return link
    })
  }

  events(id: string): SessionLinkEvent[] {
    return this.orchestration.db
      .prepare('SELECT document FROM session_link_events WHERE link_id = ? ORDER BY sequence')
      .all(id)
      .map((row) => {
        const event = SessionLinkEvent.parse(JSON.parse(storedDocument.parse(row).document))
        return event
      })
  }

  event(id: string): SessionLinkEvent | null {
    const row = this.orchestration.db
      .prepare('SELECT document FROM session_link_events WHERE id = ?')
      .get(id)
    return row ? SessionLinkEvent.parse(JSON.parse(storedDocument.parse(row).document)) : null
  }

  write(event: SessionLinkEvent): void {
    const document = JSON.stringify(SessionLinkEvent.parse(event))
    this.orchestration.db
      .prepare(
        'INSERT INTO session_link_events (id, link_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document'
      )
      .run(event.id, event.linkId, document)
  }

  control(
    id: string,
    actor: string,
    operationId: string,
    version: number,
    action: 'pause' | 'resume' | 'stop' | 'end',
    requestId?: string,
    summary = ''
  ): SessionLink {
    return this.transaction(() => {
      const previous = this.event(operationId)
      const link = this.get(id)
      if (previous) {
        if (
          previous.linkId !== id ||
          previous.actor !== actor ||
          previous.detail !== action ||
          previous.body !== summary
        ) {
          throw new Error('Operation belongs to another session link action.')
        }
        return link
      }
      if (link.version !== version) {
        throw new Error('The link changed. Refresh before acting.')
      }
      if (link.state === 'ended') {
        throw new Error('This session link has ended.')
      }
      link.state = action === 'end' ? 'ended' : action === 'resume' ? 'active' : 'paused'
      link.reason = action === 'resume' ? '' : action
      link.version++
      link.updatedAt = Date.now()
      if (action === 'resume') {
        link.turns = 0
        link.messages = 0
        for (const event of this.events(id)) {
          if (event.state === 'blocked' && event.retryable === true) {
            this.write({
              ...event,
              state: 'queued',
              retryable: false,
              detail: '',
              operationId: mintAgentSessionOperationId(Date.now())
            })
          }
        }
      }
      this.save(link)
      if (action === 'end') {
        this.orchestration.db
          .prepare('DELETE FROM session_link_participants WHERE link_id = ?')
          .run(id)
        for (const e of this.events(id)) {
          if (['queued', 'blocked'].includes(e.state)) {
            this.write({ ...e, state: 'cancelled' })
          }
        }
      }
      this.write({
        id: operationId,
        linkId: id,
        actor,
        recipient: null,
        kind: 'control',
        messageId: null,
        replyTo: null,
        state: 'recorded',
        operationId: '',
        createdAt: Date.now(),
        detail: action,
        body: summary,
        ...(requestId ? { requestId } : {})
      })
      return link
    })
  }

  append(input: SessionLinkAppend): SessionLinkEvent {
    return appendSessionLinkMessage(this, input)
  }

  reserve(id: string, eventId: string): SessionLinkEvent | null {
    return this.transaction(() => {
      const link = this.get(id)
      const event = this.events(id).find((e) => e.id === eventId)
      if (!event || link.state !== 'active' || !['queued', 'dispatching'].includes(event.state)) {
        return null
      }
      if (event.state === 'dispatching') {
        return event
      }
      const turnLimit = link.policy ? link.policy.turnLimit : SESSION_LINK_TURN_LIMIT
      if (turnLimit !== null && link.turns >= turnLimit) {
        this.pause(link.id, 'turn-limit')
        return null
      }
      link.turns++
      this.save(link)
      const reserved = { ...event, state: 'dispatching' as const }
      this.write(reserved)
      return reserved
    })
  }
}
