import {
  readMessageQuestionSource,
  snapshot,
  parseJson,
  type MessageQuestionSnapshot,
  type StoredSource
} from './message-question-snapshot'
export type { MessageQuestionSnapshot } from './message-question-snapshot'
import { resolve } from 'node:path'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { messageQuestionSourceSchema } from './message-question-source'
import {
  messageQuestionOccurrenceSchema,
  type MessageQuestionOccurrence
} from '../../shared/message-question-occurrence'
import type Database from '../sqlite/sync-database'
import type { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import {
  messageQuestionSourceId,
  messageQuestionOccurrenceId,
  messageQuestionSourceStateSchema,
  type MessageQuestionSource,
  type MessageQuestionSourceState
} from './message-question-source'
import {
  reconcileMessageQuestionResolution,
  type MessageQuestionFacts
} from './message-question-lifecycle'

export type MessageQuestionReconciliation = {
  snapshot: MessageQuestionSnapshot
  writeError?: unknown
  incomplete?: true
}
const repositories = new WeakMap<Database.Database, MessageQuestionRepository>()

export function messageQuestionsFor(database: JournalHostDatabase): MessageQuestionRepository {
  const db = database.db
  let repository = repositories.get(db)
  if (!repository) {
    repository = new MessageQuestionRepository(database)
    repositories.set(db, repository)
  }
  return repository
}

/** Called inside the existing owner-deletion transaction, never on watcher/window teardown. */
export function invalidateMessageQuestionSession(db: Database.Database, sessionId: string): void {
  const sources = db
    .prepare('SELECT source_id FROM message_question_sources WHERE owner_session_id = ?')
    .all(sessionId)
  for (const source of sources) {
    if (typeof source.source_id === 'string') {
      repositories.get(db)?.invalidate(source.source_id)
    }
  }
}

export class MessageQuestionRepository {
  private readonly sources = new Map<string, StoredSource>()
  private readonly owners = new Map<
    string,
    { source: MessageQuestionSource; release: () => void }
  >()
  constructor(private readonly database: JournalHostDatabase) {}

  invalidate(sourceId: string): void {
    this.sources.delete(sourceId)
  }

  private load(sourceId: string): StoredSource {
    const db = this.database.db
    const cached = this.sources.get(sourceId)
    if (cached) {
      return cached
    }
    const stored = readMessageQuestionSource(db, sourceId)
    this.sources.set(sourceId, stored)
    return stored
  }

  current(source: MessageQuestionSource): MessageQuestionSnapshot {
    return this.load(messageQuestionSourceId(source)).snapshot
  }

  sourceState(source: MessageQuestionSource): MessageQuestionSourceState | null {
    const row = this.database.db
      .prepare('SELECT state_json FROM message_question_sources WHERE source_id = ?')
      .get(messageQuestionSourceId(source))
    return row?.state_json == null
      ? null
      : messageQuestionSourceStateSchema.parse(parseJson(row.state_json))
  }

  /** Input is only changed definitions plus canonical facts; unrelated output passes no definitions. */
  reconcile(
    source: MessageQuestionSource,
    upserts: readonly MessageQuestionOccurrence[],
    facts: MessageQuestionFacts = {},
    state?: MessageQuestionSourceState
  ): MessageQuestionReconciliation {
    const sourceId = messageQuestionSourceId(source)
    const prior = this.load(sourceId)
    const hasFacts = Boolean(
      facts.delivered?.size ||
      facts.interruptedTurns?.size ||
      facts.interruptedContexts?.size ||
      facts.retiredContexts?.size ||
      facts.replacedOccurrences?.size
    )
    const savedById =
      upserts.length || hasFacts
        ? new Map(prior.snapshot.records.map((record) => [record.id, record]))
        : new Map<string, MessageQuestionOccurrence>()
    const next = new Map(savedById)
    let definitionChanged = false
    for (const incoming of upserts) {
      const record = messageQuestionOccurrenceSchema.parse(incoming)
      if (
        record.sourceId !== sourceId ||
        record.id !== messageQuestionOccurrenceId(source, record.context, record)
      ) {
        throw new Error('Message question identity mismatch')
      }
      const saved = next.get(record.id)
      const definition =
        saved && saved.resolution.state !== 'pending'
          ? { ...record, resolution: saved.resolution }
          : record
      if (!saved || JSON.stringify(definition) !== prior.json.get(record.id)) {
        definitionChanged = true
      }
      next.set(record.id, definition)
    }
    if (hasFacts) {
      for (const [id, record] of next) {
        const resolution = reconcileMessageQuestionResolution(record, facts)
        if (resolution !== record.resolution) {
          next.set(id, { ...record, resolution })
        }
      }
    }
    const writes = new Map<string, string>()
    for (const [id, record] of next) {
      if (record === savedById.get(id)) {
        continue
      }
      const json = JSON.stringify(record)
      if (json !== prior.json.get(id)) {
        writes.set(id, json)
      }
    }
    const effective = writes.size ? snapshot(next.values()) : prior.snapshot
    try {
      this.database.transaction((db) => {
        db.prepare(
          'INSERT INTO message_question_sources (source_id, owner_session_id, identity_json, state_json) VALUES (?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET state_json = COALESCE(excluded.state_json, message_question_sources.state_json)'
        ).run(
          sourceId,
          source.kind === 'structured' ? source.sessionId : null,
          JSON.stringify(source),
          state ? JSON.stringify(state) : null
        )
        const write = db.prepare(
          'INSERT INTO message_question_occurrences (occurrence_id, source_id, record_json) VALUES (?, ?, ?) ON CONFLICT(occurrence_id) DO UPDATE SET record_json = excluded.record_json'
        )
        for (const [id, json] of writes) {
          write.run(id, sourceId, json)
        }
      })
      if (writes.size) {
        this.sources.set(sourceId, {
          snapshot: effective,
          json: new Map([...prior.json, ...writes])
        })
      }
      return { snapshot: effective }
    } catch (writeError) {
      // Canonical terminal evidence still masks stale saved pending; uncommitted creations stay private.
      return {
        snapshot: snapshot(effective.records.filter((record) => prior.json.has(record.id))),
        writeError,
        ...(definitionChanged ? { incomplete: true as const } : {})
      }
    }
  }

  /** The caller supplies its authenticated owner source; terminal targets are idempotent. */
  cancel(
    source: MessageQuestionSource,
    ids: readonly string[],
    caller: string,
    now: number,
    facts: MessageQuestionFacts = {}
  ): MessageQuestionSnapshot {
    if (!caller) {
      throw new Error('Message question cancellation needs an authenticated caller')
    }
    const reconciled = this.reconcile(source, [], facts)
    if (reconciled.writeError) {
      throw reconciled.writeError
    }
    const sourceId = messageQuestionSourceId(source)
    let changed = false
    this.database.transaction((db) => {
      const targets = [...new Set(ids)].map((id) => {
        const row = db
          .prepare(
            'SELECT source_id, record_json FROM message_question_occurrences WHERE occurrence_id = ?'
          )
          .get(id)
        if (!row || row.source_id !== sourceId) {
          throw new Error('Question does not belong to this source')
        }
        const record = messageQuestionOccurrenceSchema.parse(parseJson(row.record_json))
        if (record.responseMode !== 'message' || record.sourceId !== sourceId) {
          throw new Error('Question cannot be cancelled here')
        }
        return record
      })
      for (const record of targets) {
        if (record.resolution.state !== 'pending') {
          continue
        }
        changed = true
        db.prepare(
          'UPDATE message_question_occurrences SET record_json = ? WHERE occurrence_id = ? AND source_id = ?'
        ).run(
          JSON.stringify({
            ...record,
            resolution: {
              state: 'cancelled',
              reason: 'user',
              factId: record.id,
              resolvedBy: caller,
              resolvedAt: now
            }
          }),
          record.id,
          sourceId
        )
      }
    })
    if (changed) {
      this.invalidate(sourceId)
    }
    return this.current(source)
  }

  ownSource(source: MessageQuestionSource, release: () => void): () => void {
    const id = messageQuestionSourceId(source)
    const owner = { source, release }
    this.owners.set(id, owner)
    return () => {
      if (this.owners.get(id) === owner) {
        this.owners.delete(id)
      }
    }
  }

  deleteTranscriptSources(agent: string, filePath: string): void {
    const candidates = new Map([...this.owners].map(([id, owner]) => [id, owner.source]))
    for (const row of this.database.db
      .prepare(
        'SELECT source_id, identity_json FROM message_question_sources WHERE owner_session_id IS NULL'
      )
      .all()) {
      const source = messageQuestionSourceSchema.parse(parseJson(row.identity_json))
      candidates.set(messageQuestionSourceId(source), source)
    }
    const canonicalAgent = resolveNativeChatTranscriptAgent(agent) ?? agent
    for (const source of candidates.values()) {
      if (
        source.kind === 'transcript' &&
        (resolveNativeChatTranscriptAgent(source.agent) ?? source.agent) === canonicalAgent &&
        resolve(source.filePath) === resolve(filePath)
      ) {
        this.deleteSource(source)
      }
    }
  }

  deleteSource(source: MessageQuestionSource): void {
    const sourceId = messageQuestionSourceId(source)
    this.owners.get(sourceId)?.release()
    this.owners.delete(sourceId)
    this.database.transaction((db) => {
      db.prepare('DELETE FROM message_question_sources WHERE source_id = ?').run(sourceId)
    })
    this.invalidate(sourceId)
  }
}

export function structuredMessageQuestions(
  database: JournalHostDatabase,
  identity: { sessionId: string; agent: string }
) {
  return {
    repository: messageQuestionsFor(database),
    source: {
      kind: 'structured',
      sessionId: identity.sessionId,
      agent: identity.agent
    } satisfies MessageQuestionSource
  }
}
