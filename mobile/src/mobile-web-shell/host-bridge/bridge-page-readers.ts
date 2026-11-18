import type { BridgeSessionBack } from './bridge-host-back'
import type { BridgeClientMessage } from '../bridge/protocol/bridge-envelope'
import type { BridgeInitRoute } from '../bridge/protocol/bridge-init-route'
import { BRIDGE_APP_INACTIVE_FRAME } from '../bridge/page-lifecycle/bridge-app-inactive'
import type { BridgeAppFrame } from '../bridge/page-lifecycle/bridge-app-resumed'

/** Document capabilities survive connection rebuilds, but never a different document's ready. */
export class BridgePageReaders {
  storageKeys: readonly string[] | null
  connectionPathFrames: boolean
  appInactiveFrames: boolean
  appResumedFrames: boolean
  private itemLinks: boolean | undefined

  constructor(
    previous: BridgeSessionBack | undefined,
    established: boolean,
    private readonly refuse: (issue: string) => void
  ) {
    this.storageKeys = previous?.storageKeys ?? null
    this.connectionPathFrames = previous?.connectionPathFrames === true
    this.appInactiveFrames = previous?.appInactiveFrames === true
    this.appResumedFrames = previous?.appResumedFrames === true
    this.itemLinks = established ? previous?.botItemLinks === true : undefined
  }

  ready(message: Extract<BridgeClientMessage, { type: 'ready' }>): void {
    this.storageKeys = message.storageKeys ?? null
    this.connectionPathFrames = message.connectionPathFrames === true
    this.appInactiveFrames = message.appInactiveFrames === true
    this.appResumedFrames = message.appResumedFrames === true
    this.itemLinks = message.botItemLinks === true
  }

  reads(frame: BridgeAppFrame['type']): boolean {
    return frame === BRIDGE_APP_INACTIVE_FRAME ? this.appInactiveFrames : this.appResumedFrames
  }

  accepts(route: BridgeInitRoute): boolean {
    if (!route.params?.botItem) {
      return true
    }
    if (this.itemLinks === undefined) {
      return false
    }
    if (!this.itemLinks) {
      this.refuse('bot-item-links-unsupported')
    }
    return this.itemLinks
  }

  retained(): Partial<BridgeSessionBack> {
    return {
      ...(this.storageKeys === null ? {} : { storageKeys: this.storageKeys }),
      ...(this.connectionPathFrames ? { connectionPathFrames: true as const } : {}),
      ...(this.appInactiveFrames ? { appInactiveFrames: true as const } : {}),
      ...(this.appResumedFrames ? { appResumedFrames: true as const } : {}),
      ...(this.itemLinks ? { botItemLinks: true as const } : {})
    }
  }
}
