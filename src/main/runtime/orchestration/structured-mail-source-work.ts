import { MailPending, type Interest, type SourceIdentity } from './structured-mail-source-discovery'

/** Source ownership outlives target leaves and every awaited ordinary acceptance. */
export class MailSourceWork {
  private readonly mailboxes = new Map<string, MailPending>()
  private readonly scopes = new Map<string, Set<string>>()
  private readonly attempts = new Map<string, object>()
  pending(mailbox: string): MailPending {
    let pending = this.mailboxes.get(mailbox)
    if (!pending) {
      pending = new MailPending((id, present) => {
        const scopes = this.scopes.get(id) ?? new Set<string>()
        if (present) {
          scopes.add(mailbox)
        } else {
          scopes.delete(mailbox)
        }
        if (scopes.size) {
          this.scopes.set(id, scopes)
        } else {
          this.scopes.delete(id)
        }
      })
      this.mailboxes.set(mailbox, pending)
    }
    return pending
  }
  clear(): void {
    this.mailboxes.clear()
    this.scopes.clear()
    this.attempts.clear()
  }
  detach(mailbox: string): void {
    const pending = this.mailboxes.get(mailbox)
    for (const id of pending?.keys() ?? []) {
      pending?.delete(id)
    }
    this.mailboxes.delete(mailbox)
  }
  forget(id: string, retire: (mailbox: string) => void): void {
    for (const mailbox of this.scopes.get(id) ?? []) {
      retire(mailbox)
      this.mailboxes.get(mailbox)?.delete(id)
    }
  }
  async run(input: {
    mailbox: string
    interest: Interest
    source: SourceIdentity
    current: () => boolean
    offer: (
      current: () => boolean,
      capture: () => void,
      retire: (id: string, scopeOnly?: boolean) => void
    ) => Promise<void>
    retire: (id: string) => void
    interestFor: (mailbox: string) => Interest | undefined
    wake: (mailbox: string) => void
  }): Promise<void> {
    const { source, interest, current } = input
    if (this.attempts.has(source.id)) {
      return
    }
    const token = {}
    this.attempts.set(source.id, token)
    let revision = interest.dirty.get(source.id)
    const observe = () =>
      [...(this.scopes.get(source.id) ?? [])].map((mailbox) => {
        const pending = this.mailboxes.get(mailbox)!
        const deferred = input.interestFor(mailbox)?.deferred
        return {
          mailbox,
          pending,
          revision: pending.get(source.id),
          deferred,
          debt: deferred?.get(source.id)
        }
      })
    let observations = observe()
    const owned = () =>
      current() &&
      this.attempts.get(source.id) === token &&
      interest.dirty.get(source.id) === revision
    try {
      await input.offer(
        owned,
        () => {
          interest.db.mailSourceMutations.flushCommitted()
          revision = interest.dirty.get(source.id)
          observations = observe()
        },
        (id, scopeOnly) => {
          if (owned()) {
            input.retire(id)
            if (!scopeOnly) {
              for (const observed of observations) {
                if (
                  observed.mailbox !== input.mailbox &&
                  this.mailboxes.get(observed.mailbox) === observed.pending &&
                  observed.pending.get(id) === observed.revision &&
                  input.interestFor(observed.mailbox)?.deferred === observed.deferred &&
                  observed.deferred?.get(id) === observed.debt
                ) {
                  observed.deferred?.delete(id)
                  observed.pending.delete(id)
                }
              }
            }
          }
        }
      )
      if (owned()) {
        interest.dirty.delete(source.id)
      }
    } finally {
      if (this.attempts.get(source.id) === token) {
        this.attempts.delete(source.id)
        for (const mailbox of this.scopes.get(source.id) ?? []) {
          queueMicrotask(() => input.wake(mailbox))
        }
      }
    }
  }
}
