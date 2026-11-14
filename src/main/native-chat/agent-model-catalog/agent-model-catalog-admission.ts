import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { AGENT_MODEL_CATALOG_PICKER_WAIT_MS } from './agent-model-catalog-listing-waiters'

type AccountAdmission = { slots: PrioritySemaphore; references: number }
export type AgentModelCatalogListingAdmission = Pick<PrioritySemaphore, 'acquire'>

export class AgentModelCatalogAdmission {
  private readonly startup = new PrioritySemaphore(2)
  private readonly accounts = new Map<string, AccountAdmission>()

  forAccount(key: string): AgentModelCatalogListingAdmission {
    return { acquire: (_priority, signal) => this.acquire(key, signal) }
  }

  private async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    const account = this.accounts.get(key) ?? { slots: new PrioritySemaphore(2), references: 0 }
    this.accounts.set(key, account)
    account.references++
    let releaseAccount: (() => void) | undefined
    const forget = () => {
      releaseAccount?.()
      if (--account.references === 0) {
        this.accounts.delete(key)
      }
    }
    try {
      // A stalled account must never hold startup capacity while waiting for its own children.
      releaseAccount = await account.slots.acquire(0, signal)
      const releaseStartup = await this.startup.acquire(0, signal)
      let timer: ReturnType<typeof setTimeout> | undefined
      const yieldStartup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', yieldStartup)
        releaseStartup()
      }
      timer = setTimeout(yieldStartup, AGENT_MODEL_CATALOG_PICKER_WAIT_MS)
      signal?.addEventListener('abort', yieldStartup, { once: true })
      if (signal?.aborted) {
        yieldStartup()
      }
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        yieldStartup()
        // Physical account ownership survives logical retirement until provider teardown settles.
        forget()
      }
    } catch (error) {
      forget()
      throw error
    }
  }
}
