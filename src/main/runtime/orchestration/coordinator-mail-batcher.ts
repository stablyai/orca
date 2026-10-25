import type { MessageRow } from './db'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './db/messages/mailbox-routing-page'
import { MailPointerRepointScheduler } from './mail-pointer-repoint-scheduler'

export class CoordinatorMailBatcher {
  private readonly sessionByMailbox = new Map<string, string>()
  private readonly scheduler: MailPointerRepointScheduler

  constructor(flush: (mailboxHandle: string, sessionId: string) => void) {
    this.scheduler = new MailPointerRepointScheduler((mailboxHandle) => {
      const sessionId = this.sessionByMailbox.get(mailboxHandle)
      this.sessionByMailbox.delete(mailboxHandle)
      if (sessionId !== undefined) {
        flush(mailboxHandle, sessionId)
      }
    }, 60_000)
  }

  defer(mailboxHandle: string, sessionId: string, unread: readonly MessageRow[]): boolean {
    if (!mailboxHandle.startsWith('run:')) {
      return false
    }
    const pendingSessionId = this.sessionByMailbox.get(mailboxHandle)
    const batchable =
      unread.length < ORCHESTRATION_DELIVERY_BATCH_LIMIT &&
      unread.every(
        (message) =>
          message.priority === 'normal' &&
          ['status', 'heartbeat', 'worker_done'].includes(message.type)
      )
    if (!batchable || (pendingSessionId && pendingSessionId !== sessionId)) {
      this.scheduler.cancel(mailboxHandle)
      this.sessionByMailbox.delete(mailboxHandle)
    }
    if (!batchable) {
      return false
    }
    this.sessionByMailbox.set(mailboxHandle, sessionId)
    this.scheduler.schedule(mailboxHandle)
    return true
  }

  forgetSession(sessionId: string): void {
    for (const [mailboxHandle, ownerSessionId] of this.sessionByMailbox) {
      if (ownerSessionId !== sessionId) {
        continue
      }
      this.scheduler.cancel(mailboxHandle)
      this.sessionByMailbox.delete(mailboxHandle)
    }
  }

  clear(): void {
    this.scheduler.clear()
    this.sessionByMailbox.clear()
  }
}
