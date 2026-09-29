import type { ConversationKnowledgeHandoffEntry } from '../../shared/conversation-knowledge-items'

export function normalizeConversationKnowledgeHandoff(
  values: readonly unknown[]
): ConversationKnowledgeHandoffEntry[] {
  return values.flatMap((value) => (isHandoffEntry(value) ? [normalizeEntry(value)] : []))
}

export function retainSourceBackedHandoff(
  handoff: readonly ConversationKnowledgeHandoffEntry[],
  messages: readonly { id: string; role: string; text?: string }[]
): ConversationKnowledgeHandoffEntry[] {
  const messagesById = new Map(messages.map((message) => [message.id, message]))
  return handoff.flatMap((entry) => {
    const message = messagesById.get(entry.evidence.messageId)
    const supportingMessages = (entry.evidence.supportingMessageIds ?? []).map((messageId) =>
      messagesById.get(messageId)
    )
    if (
      !isSourceBacked(
        entry,
        message?.role,
        supportingMessages.map((message) => message?.role)
      )
    ) {
      return []
    }
    if (!entry.claim) {
      return [entry]
    }
    const text = message?.text?.normalize('NFKC').toLocaleLowerCase() ?? ''
    const subject = entry.claim.subject.normalize('NFKC').toLocaleLowerCase()
    const object = entry.claim.object.normalize('NFKC').toLocaleLowerCase()
    return [
      subject && object && text.includes(subject) && text.includes(object) && isSpecificClaim(entry)
        ? entry
        : { ...entry, claim: undefined }
    ]
  })
}

function isSourceBacked(
  entry: ConversationKnowledgeHandoffEntry,
  evidenceRole: string | undefined,
  supportingRoles: readonly (string | undefined)[]
): boolean {
  if (entry.reliability === 'verified') {
    return entry.evidence.kind === 'tool-result' && evidenceRole !== undefined
  }
  return (
    entry.reliability === 'user-confirmed' &&
    entry.evidence.kind === 'conversation' &&
    evidenceRole === 'user' &&
    supportingRoles.every((role) => role === 'user')
  )
}

function isSpecificClaim(entry: ConversationKnowledgeHandoffEntry): boolean {
  const claim = entry.claim
  if (!claim) {
    return false
  }
  const subject = claim.subject.normalize('NFKC').trim()
  const object = claim.object.normalize('NFKC').trim()
  return (
    !/^方案\s*[A-Za-z0-9]+$/u.test(subject) ||
    !/^(?:进行|确认|同意|继续|好|好的|可以)$/u.test(object)
  )
}

function normalizeEntry(
  entry: ConversationKnowledgeHandoffEntry
): ConversationKnowledgeHandoffEntry {
  return {
    ...entry,
    text: entry.text.trim().slice(0, 500),
    evidence: {
      ...entry.evidence,
      ...(entry.evidence.supportingMessageIds
        ? {
            supportingMessageIds: [
              ...new Set(entry.evidence.supportingMessageIds.map((messageId) => messageId.trim()))
            ]
              .filter(
                (messageId) => messageId.length > 0 && messageId !== entry.evidence.messageId.trim()
              )
              .slice(0, 3)
          }
        : {})
    },
    ...(entry.claim
      ? {
          claim: {
            subject: entry.claim.subject.trim().slice(0, 120),
            relation: entry.claim.relation.trim().slice(0, 120),
            object: entry.claim.object.trim().slice(0, 120),
            cardinality: 'single' as const
          }
        }
      : {}),
    ...(entry.concepts
      ? {
          concepts: [...new Set(entry.concepts.map((concept) => concept.trim()).filter(Boolean))]
            .slice(0, 3)
            .map((concept) => concept.slice(0, 120))
        }
      : {}),
    ...(entry.knowledge
      ? {
          knowledge: {
            kind: entry.knowledge.kind,
            applicability: entry.knowledge.applicability.trim().slice(0, 240),
            reusable: true as const
          }
        }
      : {})
  }
}

function isHandoffEntry(value: unknown): value is ConversationKnowledgeHandoffEntry {
  const record = toRecord(value)
  const evidenceRecord = toRecord(record?.evidence)
  return (
    record !== null &&
    evidenceRecord !== null &&
    (record.kind === 'decision' ||
      record.kind === 'constraint' ||
      record.kind === 'progress' ||
      record.kind === 'open-loop') &&
    typeof record.text === 'string' &&
    record.text.trim().length > 0 &&
    (record.reliability === 'user-confirmed' ||
      record.reliability === 'verified' ||
      record.reliability === 'inferred' ||
      record.reliability === 'proposal') &&
    (evidenceRecord.kind === 'conversation' || evidenceRecord.kind === 'tool-result') &&
    typeof evidenceRecord.messageId === 'string' &&
    evidenceRecord.messageId.length > 0 &&
    (evidenceRecord.supportingMessageIds === undefined ||
      (Array.isArray(evidenceRecord.supportingMessageIds) &&
        evidenceRecord.supportingMessageIds.every((messageId) => typeof messageId === 'string'))) &&
    isOptionalClaim(record.claim) &&
    isOptionalConcepts(record.concepts) &&
    isOptionalKnowledge(record.knowledge)
  )
}

function isOptionalConcepts(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 3 &&
      value.every((concept) => typeof concept === 'string' && concept.trim().length > 0))
  )
}

function isOptionalKnowledge(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  const knowledge = toRecord(value)
  return (
    knowledge !== null &&
    (knowledge.kind === 'fact' ||
      knowledge.kind === 'method' ||
      knowledge.kind === 'finding' ||
      knowledge.kind === 'decision' ||
      knowledge.kind === 'constraint') &&
    typeof knowledge.applicability === 'string' &&
    knowledge.applicability.trim().length > 0 &&
    knowledge.reusable === true
  )
}

function isOptionalClaim(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  const claim = toRecord(value)
  return (
    claim !== null &&
    typeof claim.subject === 'string' &&
    typeof claim.relation === 'string' &&
    typeof claim.object === 'string' &&
    claim.cardinality === 'single'
  )
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
