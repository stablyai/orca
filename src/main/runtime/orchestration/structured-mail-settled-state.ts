import { settleStructuredMailSends } from './structured-mail-custody'
/** When the lane must settle a mailbox's earlier sends again, and when a session's status matters to
 *  its mail. Settling asks the chat what became of every send still out, so it runs only when
 *  something those sends wait on moved: never per arrival or page. In memory only: a restart settles
 *  every mailbox once, as nothing here is known yet. */
export class StructuredMailSettledState {
  /** The owner a mailbox was last settled for, and its change count then. */
  private readonly settled = new Map<
    string,
    { owner: string | null; change: number; complete: boolean }
  >()
  private readonly changes = new Map<string, number>()
  /** Each session's last status and fence. */
  private readonly edges = new Map<string, string>()

  /** Something its sends wait on moved: a journal edge, a cleanup, a handover dropping one. */
  invalidate(mailboxHandle: string): void {
    this.changes.set(mailboxHandle, (this.changes.get(mailboxHandle) ?? 0) + 1)
  }

  needsSettling(mailboxHandle: string, owner: string | null): boolean {
    const last = this.settled.get(mailboxHandle)
    return (
      !last?.complete ||
      last.owner !== owner ||
      last.change !== (this.changes.get(mailboxHandle) ?? 0)
    )
  }

  /** Settle under the change count read before it, so a change during the settle runs it again. */
  async settle<T>(mailboxHandle: string, owner: string | null, run: () => Promise<T>): Promise<T> {
    const entry = { owner, change: this.changes.get(mailboxHandle) ?? 0, complete: false }
    this.settled.set(mailboxHandle, entry)
    const settled = await run()
    if (this.settled.get(mailboxHandle) === entry) {
      entry.complete = true
    }
    return settled
  }

  settleMailbox(
    mailbox: string,
    owner: string | null,
    ended: boolean,
    input: Parameters<typeof settleStructuredMailSends>[0]
  ) {
    return this.needsSettling(mailbox, owner) || ended
      ? this.settle(mailbox, owner, () => settleStructuredMailSends(input))
      : Promise.resolve({ resend: [], released: false })
  }

  /** No send of it is left in any chat. */
  forget(mailboxHandle: string): void {
    this.settled.delete(mailboxHandle)
    this.changes.delete(mailboxHandle)
  }

  /** A status callback matters to mail only when the status or the session's fence (a reattach) moved:
   *  what its journal changes is its watch's to hear. Attention is recorded too, so the turn that
   *  follows an answer is a change. */
  statusChanged(sessionId: string, status: string | null, fence: number | null): boolean {
    const edge = `${status}:${fence}`
    if (this.edges.get(sessionId) === edge) {
      return false
    }
    this.edges.set(sessionId, edge)
    return true
  }

  clear(): void {
    this.edges.clear()
    this.settled.clear()
    this.changes.clear()
  }

  forgetSession(sessionId: string): void {
    this.edges.delete(sessionId)
  }
}
