import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { mailDisplayAttachmentKey } from '../../../shared/agent-session/mail-display-report'
import type { JournalReducerState } from './journal-reducer'
import { JournalDraftMap } from './journal-transition-collections'
import { journalInputSourceBody } from './journal-input-source'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'

function references(body: AgentJournalMessageItem | null | undefined): Set<string> {
  const mail = orchestrationMailNotice(body?.from)
  return new Set(
    mail?.messages.map((ref) => mailDisplayAttachmentKey({ ...ref, mailbox: mail.mailbox }))
  )
}

/** Bounded by retained mail owners; normal commits visit only the existing transition's touched keys. */
export class JournalMailDisplayRetention {
  private readonly owners = new Map<string, Set<string>>()
  private readonly references = new Map<string, Set<string>>()

  private replace(owner: string, next: Set<string>): void {
    for (const key of this.owners.get(owner) ?? []) {
      const owners = this.references.get(key)
      owners?.delete(owner)
      if (!owners?.size) {
        this.references.delete(key)
      }
    }
    if (!next.size) {
      this.owners.delete(owner)
    } else {
      this.owners.set(owner, next)
    }
    for (const key of next) {
      const owners = this.references.get(key) ?? new Set<string>()
      owners.add(owner)
      this.references.set(key, owners)
    }
  }

  rebuild(
    state: JournalReducerState,
    legacy: readonly { messageId: string; body: AgentJournalMessageItem }[] = []
  ): void {
    this.clear()
    for (const [id, source] of state.inputs.sources) {
      this.replace(`input:${id}`, references(journalInputSourceBody(source)))
    }
    for (const [id, item] of state.items) {
      this.replace(`item:${id}`, references(item.body.kind === 'message' ? item.body : null))
    }
    for (const card of legacy) {
      this.replace(`queue:${card.messageId}`, references(card.body))
    }
    for (const [id, card] of state.queue.cards) {
      this.replace(
        `queue:${id}`,
        references(card.state === 'waiting' || card.state === 'returned' ? card.body : null)
      )
    }
  }

  has(key: string): boolean {
    return this.references.has(key)
  }

  stage(state: JournalReducerState): { retired: string[]; committed: () => void } {
    const changed = new Map<string, Set<string>>()
    const touched = <V>(map: Map<string, V>) =>
      map instanceof JournalDraftMap ? map.touchedKeys() : []
    for (const id of touched(state.inputs.sources)) {
      changed.set(`input:${id}`, references(journalInputSourceBody(state.inputs.sources.get(id))))
    }
    for (const id of touched(state.items)) {
      const body = state.items.get(id)?.body
      changed.set(`item:${id}`, references(body?.kind === 'message' ? body : null))
    }
    for (const id of touched(state.queue.cards)) {
      const card = state.queue.cards.get(id)
      changed.set(
        `queue:${id}`,
        references(card?.state === 'waiting' || card?.state === 'returned' ? card.body : null)
      )
    }
    const removed = new Map<string, number>()
    const gained = new Set<string>()
    for (const [owner, next] of changed) {
      for (const key of this.owners.get(owner) ?? []) {
        removed.set(key, (removed.get(key) ?? 0) + 1)
      }
      for (const key of next) {
        gained.add(key)
      }
    }
    const retired = [...removed]
      .filter(([key, count]) => !gained.has(key) && (this.references.get(key)?.size ?? 0) === count)
      .map(([key]) => key)
    return {
      retired,
      committed: () => {
        for (const [owner, next] of changed) {
          this.replace(owner, next)
        }
      }
    }
  }

  clear(): void {
    this.owners.clear()
    this.references.clear()
  }
}
