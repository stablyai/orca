import type { MessageQuestionOccurrence } from '../../shared/message-question-occurrence'

/** Rebuild canonical addresses from saved occurrences without changing their durable identity. */
export function messageQuestionAddressIndex(
  records: readonly MessageQuestionOccurrence[],
  canonicalContext?: (record: MessageQuestionOccurrence) => string
) {
  const addresses = new Map<string, MessageQuestionOccurrence>()
  const contextAliases = new Map<string, string>()
  const replaced: MessageQuestionOccurrence[] = []
  if (canonicalContext) {
    for (const record of records) {
      const context = canonicalContext(record)
      contextAliases.set(record.context, context)
      const key = JSON.stringify([context, record.sourceRowId, record.callSlot])
      const prior = addresses.get(key)
      if (
        !prior ||
        (prior.resolution.state === 'pending' && record.resolution.state !== 'pending')
      ) {
        addresses.set(key, record)
      }
    }
    for (const record of records) {
      const key = JSON.stringify([canonicalContext(record), record.sourceRowId, record.callSlot])
      if (addresses.get(key)?.id !== record.id) {
        replaced.push(record)
      }
    }
  }
  return { addresses, contextAliases, replaced }
}

export function expandMessageQuestionContextFacts<T>(
  contextAliases: ReadonlyMap<string, string>,
  facts: ReadonlyMap<string, T>
): ReadonlyMap<string, T> {
  if (!contextAliases.size) {
    return facts
  }
  const result = new Map(facts)
  for (const [saved, semantic] of contextAliases) {
    const fact = facts.get(semantic)
    if (fact !== undefined) {
      result.set(saved, fact)
    }
  }
  return result
}
