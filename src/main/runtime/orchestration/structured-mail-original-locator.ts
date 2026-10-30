import { parseJournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
export const mailMemberKey = (runId: string, id: string): string => JSON.stringify([runId, id])
export const originalReference = (session: string, key: string) => JSON.stringify([session, key])
export const originalCoordinate = (epoch: string, sequence: number) =>
  JSON.stringify([epoch, sequence])
type Original = { draft: string | null; members: Set<string> }
export class MailOriginalLocator {
  readonly originals = new Map<string, Original>()
  readonly drafts = new Map<string, Set<string>>()
  readOriginal(session: string, at: string, json: unknown): void {
    const key = originalReference(session, at)
    const old = this.originals.get(key)
    if (old?.draft) {
      const candidates = this.drafts.get(old.draft)
      candidates?.delete(key)
      if (!candidates?.size) {
        this.drafts.delete(old.draft)
      }
    }
    this.originals.delete(key)
    const parsed = typeof json === 'string' ? parseJournalRow(json) : null
    if (!parsed?.ok) {
      return
    }
    const row = parsed.row
    const initial =
      row.kind === 'queue' &&
      row.change.op === 'queued' &&
      originalCoordinate(row.change.queuedAt.epoch, row.change.queuedAt.sequence + 1) === at
    const body =
      row.kind === 'submission'
        ? row.body
        : initial && row.kind === 'queue' && row.change.op === 'queued'
          ? row.change.body
          : null
    if (!body) {
      return
    }
    const mail = body.from?.orchestration
    const draft = initial && row.kind === 'queue' ? originalReference(session, row.messageId) : null
    const original: Original = {
      draft,
      members: new Set(
        mail?.message === 'mail-notice'
          ? mail.messages.map((m) => mailMemberKey(m.runId, m.messageId))
          : []
      )
    }
    // Retain queue locators, and only mail bodies for direct journal-row references.
    if (draft || original.members.size) {
      this.originals.set(key, original)
    }
    if (draft) {
      const candidates = this.drafts.get(draft) ?? new Set<string>()
      candidates.add(key)
      this.drafts.set(draft, candidates)
    }
  }
}
