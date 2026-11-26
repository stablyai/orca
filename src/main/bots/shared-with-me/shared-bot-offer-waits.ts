// The accepts made on this computer, each owed one share-list read that waits on Orca Cloud for the
// host's offer to this device. Until that read and its dial settle, the agent shows as connecting.
import type { SharedBotHostEntry } from './shared-bot-host-store'
import type { SharedBotOfferWait } from './shared-bots-cloud'
import { sharedBotsPollMs } from './shared-bot-pairing'

export class SharedBotOfferWaits {
  private readonly accepting = new Set<string>()
  // One share per read, oldest accept first.
  private readonly owed: SharedBotOfferWait[] = []

  accepted(entry: Pick<SharedBotHostEntry, 'shareId' | 'deviceKey'>): void {
    this.accepting.add(entry.shareId)
    this.owed.push({ shareId: entry.shareId, devicePublicKey: entry.deviceKey.publicKeyB64 })
  }

  /** The wait the next read carries, if an accept is owed one. */
  take(): SharedBotOfferWait | undefined {
    return this.owed.shift()
  }

  /** That read and its dial settled: live, or away until the usual pace finds the offer. */
  settled(wait: SharedBotOfferWait | undefined): void {
    if (wait) {
      this.accepting.delete(wait.shareId)
    }
  }

  connecting(shareId: string, link: string): boolean {
    return link !== 'live' && this.accepting.has(shareId)
  }

  /** The next read's delay: at once while an accept is owed its wait, else the usual pace. */
  nextReadMs(...usual: Parameters<typeof sharedBotsPollMs<SharedBotHostEntry>>): number | null {
    return this.owed.length > 0 ? 0 : sharedBotsPollMs(...usual)
  }
}
