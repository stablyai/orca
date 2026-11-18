// An automation save that names a webhook: its hook is made (or kept) before the save, and the make
// is settled after it, or given up when the save fails.
import { randomUUID } from 'node:crypto'
import {
  isWebhookTrigger,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import { WEBHOOKS_NOT_CONNECTED } from './webhook-hooks'
import type { AutomationWebhooks } from './webhook-host-service'

export class AutomationWebhookSaves {
  // Only a desktop signed in to Orca Cloud hosts the connector, so only it makes webhooks.
  private webhooks: AutomationWebhooks | null = null

  set(webhooks: AutomationWebhooks | null): void {
    this.webhooks = webhooks
  }

  /** The bot, with whether its host's Orca Cloud takes webhooks and whether the host is signed out
   *  of it, for the event rule check. */
  hearing(bot: Bot): Bot & { webhooks: boolean; cloudSignedOut: boolean } {
    return {
      ...bot,
      webhooks: this.webhooks?.advertised() ?? false,
      cloudSignedOut: this.webhooks?.signedOut() ?? false
    }
  }

  /**
   * Saves a bot automation's rules. A create that names a webhook gets its id here, so the hook is
   * made for it first; write saves under that id.
   */
  async save<T>(
    owner: { botId: string; current?: Automation } | null,
    next: AutomationEventTrigger[] | undefined,
    write: (on: AutomationEventTrigger[] | undefined, newId?: string) => Promise<T>
  ): Promise<T> {
    if (!owner || !next?.some(isWebhookTrigger)) {
      return await write(next)
    }
    if (!this.webhooks) {
      throw new Error(WEBHOOKS_NOT_CONNECTED)
    }
    const webhooks = this.webhooks
    const newId = owner.current ? undefined : randomUUID()
    const automationId = owner.current?.id ?? newId ?? ''
    const { on, operationId } = await webhooks.settle({ ...owner, automationId, next })
    try {
      const saved = await write(on, newId)
      webhooks.saved(operationId)
      return saved
    } catch (error) {
      if (operationId) {
        webhooks.abandoned(operationId)
      }
      throw error
    }
  }
}
