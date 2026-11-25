import type { RuntimeTerminalDriverState } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

export type BrowserScreencastSubscriber = {
  cancel: (emitEnd?: boolean) => void
  done: Promise<void>
  connectionKey: string
  drivesAsMobile: boolean
  /** Set from `ready` on when the viewer asked with `driverEvents: 1`. */
  emitDriver?: (driver: RuntimeTerminalDriverState) => void
}

/** Only phone pairing scope claims mobile presence; the stream is shared by all client kinds. */
export function screencastSubscriberDrivesAsMobile(
  clientKind: 'mobile' | 'runtime' | undefined
): boolean {
  return clientKind === 'mobile'
}

export function resolveBrowserDriverAfterMobileRelease(
  remaining: Iterable<BrowserScreencastSubscriber>
): RuntimeTerminalDriverState {
  let fallback: BrowserScreencastSubscriber | null = null
  for (const subscriber of remaining) {
    if (subscriber.drivesAsMobile) {
      fallback = subscriber
    }
  }
  return fallback ? { kind: 'mobile', clientId: fallback.connectionKey } : { kind: 'idle' }
}
