import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConversationKnowledgeItem } from '../../shared/conversation-knowledge-items'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'

type StoredConversationKnowledge = {
  version: 1
  items: ConversationKnowledgeItem[]
}

const FILE_NAME = 'conversation-knowledge.json'

export class ConversationKnowledgeStore {
  private mutation: Promise<void> = Promise.resolve()

  constructor(private readonly userDataPath: string) {}

  async list(): Promise<ConversationKnowledgeItem[]> {
    await this.mutation
    return this.readSnapshot().then((snapshot) => snapshot.items)
  }

  upsert(item: ConversationKnowledgeItem): Promise<void> {
    const next = this.mutation.then(async () => {
      const snapshot = await this.readSnapshot()
      const existingIndex = snapshot.items.findIndex((candidate) => candidate.id === item.id)
      if (existingIndex === -1) {
        snapshot.items.push(item)
      } else {
        snapshot.items[existingIndex] = item
      }
      await this.writeSnapshot(snapshot)
    })
    this.mutation = next.catch(() => {})
    return next
  }

  remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return this.mutation
    }
    const removedIds = new Set(ids)
    const next = this.mutation.then(async () => {
      const snapshot = await this.readSnapshot()
      const items = snapshot.items.filter((item) => !removedIds.has(item.id))
      if (items.length !== snapshot.items.length) {
        await this.writeSnapshot({ ...snapshot, items })
      }
    })
    this.mutation = next.catch(() => {})
    return next
  }

  private async readSnapshot(): Promise<StoredConversationKnowledge> {
    let raw: string
    try {
      raw = await readFile(this.filePath(), 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return { version: 1, items: [] }
      }
      throw error
    }
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) {
      throw new Error('Conversation knowledge store has an unsupported format.')
    }
    return { version: 1, items: value.items.filter(isKnowledgeItem) }
  }

  private async writeSnapshot(snapshot: StoredConversationKnowledge): Promise<void> {
    writeDurableSecureJsonFile(this.filePath(), snapshot)
  }

  private filePath(): string {
    return join(ensureActiveOrcaProfile(this.userDataPath).profileDirectory, FILE_NAME)
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function isKnowledgeItem(value: unknown): value is ConversationKnowledgeItem {
  if (!isRecord(value)) {
    return false
  }
  const item = value
  const source = isRecord(item.source) ? item.source : null
  const knowledge = isRecord(item.knowledge) ? item.knowledge : null
  const generator = isRecord(item.generator) ? item.generator : null
  return (
    typeof item.id === 'string' &&
    source !== null &&
    knowledge !== null &&
    generator !== null &&
    typeof source.sessionId === 'string' &&
    typeof source.title === 'string' &&
    (source.createdAt === undefined ||
      source.createdAt === null ||
      typeof source.createdAt === 'string') &&
    (source.modifiedAt === undefined || typeof source.modifiedAt === 'string') &&
    typeof knowledge.summary === 'string' &&
    Array.isArray(knowledge.topics) &&
    Array.isArray(knowledge.conclusions) &&
    Array.isArray(knowledge.entities) &&
    (knowledge.searchTerms === undefined || Array.isArray(knowledge.searchTerms)) &&
    (knowledge.handoff === undefined ||
      (Array.isArray(knowledge.handoff) && knowledge.handoff.every(isHandoffEntry))) &&
    typeof generator.agent === 'string' &&
    typeof generator.model === 'string' &&
    typeof generator.generatedAt === 'string' &&
    (generator.formatVersion === undefined || typeof generator.formatVersion === 'number')
  )
}

function isHandoffEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = toRecord(value)
  if (!record) {
    return false
  }
  const evidence = record.evidence
  const evidenceRecord = toRecord(evidence)
  if (!evidenceRecord) {
    return false
  }
  return (
    (record.kind === 'decision' ||
      record.kind === 'constraint' ||
      record.kind === 'progress' ||
      record.kind === 'open-loop') &&
    typeof record.text === 'string' &&
    (record.reliability === 'user-confirmed' ||
      record.reliability === 'verified' ||
      record.reliability === 'inferred' ||
      record.reliability === 'proposal') &&
    (evidenceRecord.kind === 'conversation' || evidenceRecord.kind === 'tool-result') &&
    typeof evidenceRecord.messageId === 'string' &&
    (evidenceRecord.supportingMessageIds === undefined ||
      (Array.isArray(evidenceRecord.supportingMessageIds) &&
        evidenceRecord.supportingMessageIds.every((messageId) => typeof messageId === 'string'))) &&
    (record.lifecycle === undefined || isLifecycle(record.lifecycle)) &&
    (record.claim === undefined || isClaim(record.claim)) &&
    (record.concepts === undefined ||
      (Array.isArray(record.concepts) &&
        record.concepts.length <= 3 &&
        record.concepts.every(
          (concept) => typeof concept === 'string' && concept.trim().length > 0
        ))) &&
    (record.knowledge === undefined || isKnowledge(record.knowledge))
  )
}

function isLifecycle(value: unknown): boolean {
  const record = toRecord(value)
  return (
    record !== null &&
    (record.status === 'active' ||
      record.status === 'superseded' ||
      record.status === 'conflicted' ||
      record.status === 'expired') &&
    (record.reason === undefined || record.reason === 'automatic-conflict')
  )
}

function isClaim(value: unknown): boolean {
  const record = toRecord(value)
  return (
    record !== null &&
    typeof record.subject === 'string' &&
    typeof record.relation === 'string' &&
    typeof record.object === 'string' &&
    record.cardinality === 'single'
  )
}

function isKnowledge(value: unknown): boolean {
  const record = toRecord(value)
  return (
    record !== null &&
    (record.kind === 'fact' ||
      record.kind === 'method' ||
      record.kind === 'finding' ||
      record.kind === 'decision' ||
      record.kind === 'constraint') &&
    typeof record.applicability === 'string' &&
    record.reusable === true
  )
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
