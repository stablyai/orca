import { noteQuestionEdge } from '../../db/messages/question-edges'

/** One delivery pass per mailbox at a time: edges that arrive during a pass run one more after it,
 *  so none is lost. While a pass runs, what it sends isn't in the chat's journal yet. */
export class StructuredMailPasses {
  private readonly inFlight = new Set<string>()
  private readonly rerun = new Map<string, Set<string>>()

  has(mailboxHandle: string): boolean {
    return this.inFlight.has(mailboxHandle)
  }

  async run(
    mailboxHandle: string,
    reservedTypes: ReadonlySet<string> | undefined,
    pass: (reservedTypes?: ReadonlySet<string>) => Promise<void>,
    failed: () => void
  ): Promise<void> {
    if (this.inFlight.has(mailboxHandle)) {
      const reserved = this.rerun.get(mailboxHandle) ?? new Set<string>()
      reservedTypes?.forEach((type) => reserved.add(type))
      this.rerun.set(mailboxHandle, reserved)
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      await pass(reservedTypes)
    } catch (error) {
      failed()
      throw error
    } finally {
      this.inFlight.delete(mailboxHandle)
      // However the pass ended, a question its handover held is decided again.
      noteQuestionEdge({ kind: 'mailbox', mailbox: mailboxHandle })
      const rerun = this.rerun.get(mailboxHandle)
      if (rerun) {
        this.rerun.delete(mailboxHandle)
        const again = rerun.size > 0 ? rerun : undefined
        void this.run(mailboxHandle, again, pass, failed).catch(() => undefined)
      }
    }
  }
}
