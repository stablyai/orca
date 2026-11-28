import { randomBytes } from 'node:crypto'
import { matchesPairingOriginal, type FeishuMessage } from './feishu-message'
import type { FeishuTransport } from './feishu-transport'

/** One private challenge. A verification that starts saving before expiry may finish its write. */
export class FeishuPairing {
  readonly text = `Orca ${randomBytes(16).toString('hex')}`
  private readonly expires = Date.now() + 5 * 60_000
  private readonly timer: NodeJS.Timeout
  private saving = false
  private closed = false

  constructor(private readonly expired: () => void) {
    this.timer = setTimeout(() => this.expire(), this.expires - Date.now()).unref()
  }
  matches(text: string): boolean {
    return !this.closed && Date.now() < this.expires && this.text === text
  }
  async verify(
    api: FeishuTransport,
    message: FeishuMessage,
    active: () => boolean,
    save: () => Promise<boolean>
  ): Promise<'paired' | 'rejected' | 'ignored'> {
    const current = () => active() && this.matches(message.content)
    try {
      const verified = matchesPairingOriginal(await api.original(message.message_id), message)
      if (!current()) {
        return 'ignored'
      }
      if (!verified) {
        return 'rejected'
      }
      return (await this.commit(save)) ? 'paired' : 'ignored'
    } catch {
      return current() ? 'rejected' : 'ignored'
    }
  }
  async commit(save: () => Promise<boolean>): Promise<boolean> {
    if (this.closed || this.saving || Date.now() >= this.expires) {
      return false
    }
    this.saving = true
    try {
      const paired = await save()
      if (paired) {
        this.close()
      }
      return paired
    } finally {
      this.saving = false
      if (Date.now() >= this.expires) {
        this.expire()
      }
    }
  }
  close(): void {
    this.closed = true
    clearTimeout(this.timer)
  }
  private expire(): void {
    if (!this.closed && !this.saving) {
      this.close()
      this.expired()
    }
  }
}
