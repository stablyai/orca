import { isDeepStrictEqual } from 'node:util'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export function recoverResolvedPromptSessionOptions(
  record: Pick<AgentSessionRecord, 'options' | 'optionsRevision'>,
  items: readonly AgentJournalRenderItem[] | undefined
): Readonly<Record<string, string>> | undefined {
  const optionsRevision = record.optionsRevision ?? 0
  let recovered = record.options
  for (const item of items ?? []) {
    const body = item.body
    if (body.kind !== 'approval' && body.kind !== 'question') {
      continue
    }
    const settlement = body.resolution.sessionOptions
    if (
      body.resolution.state === 'resolved' &&
      settlement?.expectedRevision === optionsRevision &&
      isDeepStrictEqual(settlement.expectedValues, record.options ?? {})
    ) {
      recovered = settlement.values
    }
  }
  return recovered
}

export async function materializeResolvedPromptSessionOptions(input: {
  record: Pick<AgentSessionRecord, 'options' | 'optionsRevision'>
  items: readonly AgentJournalRenderItem[] | undefined
  persist: (options: Readonly<Record<string, string>>) => Promise<void>
}): Promise<Readonly<Record<string, string>> | undefined> {
  const recovered = recoverResolvedPromptSessionOptions(input.record, input.items)
  if (recovered !== undefined && !isDeepStrictEqual(recovered, input.record.options)) {
    await input.persist(recovered)
  }
  return recovered
}
