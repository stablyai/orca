import type { PtyOwnershipTransferJournal } from '../../../shared/pty-ownership-transfer-journal'

export function compactCompletedPtyOwnershipTransferJournals(
  journals: readonly PtyOwnershipTransferJournal[]
): PtyOwnershipTransferJournal[] | null {
  const byBridge = new Map<string, PtyOwnershipTransferJournal[]>()
  for (const journal of journals) {
    const group = byBridge.get(journal.bridgeId) ?? []
    group.push(journal)
    byBridge.set(journal.bridgeId, group)
  }
  const oldest = [...byBridge.values()]
    .filter((group) => group.every(journalIsTerminal))
    .sort((left, right) => oldestUpdatedAt(left) - oldestUpdatedAt(right))[0]
  if (!oldest) {
    return null
  }
  const bridgeId = oldest[0]?.bridgeId
  return journals.filter((journal) => journal.bridgeId !== bridgeId)
}

function journalIsTerminal(journal: PtyOwnershipTransferJournal): boolean {
  return journal.side === 'source'
    ? journal.phase === 'retired' || journal.phase === 'aborted'
    : journal.phase === 'published' || journal.phase === 'aborted'
}

function oldestUpdatedAt(journals: readonly PtyOwnershipTransferJournal[]): number {
  return Math.min(...journals.map((journal) => Date.parse(journal.updatedAt)))
}
