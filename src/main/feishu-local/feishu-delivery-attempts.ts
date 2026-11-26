import { FeishuCommandError } from './feishu-cli-status'
import type { FeishuStore } from './feishu-store-ops'

export class FeishuDeliveryAttempts {
  constructor(
    private readonly store: FeishuStore,
    private readonly account: string,
    private readonly signal: AbortSignal
  ) {}

  async run<T>(id: string, send: () => Promise<T>): Promise<T | null> {
    if (this.signal.aborted || !(await this.store.deliveryReady(this.account, id, Date.now()))) {
      return null
    }
    try {
      const result = await send()
      await this.store.deliverySucceeded(this.account, id)
      return result
    } catch (error) {
      if (this.signal.aborted) {
        return null
      }
      const code = error instanceof FeishuCommandError ? error.code : null
      await this.store.deliveryFailed(this.account, id, code, Date.now())
      // CLI stderr can include tokens, message bodies and console URLs; retain only the API code.
      console.warn('[feishu] delivery failed', { id, code })
      return null
    }
  }
}
