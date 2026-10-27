import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'

export type BrowserScreencastSubscriber = {
  cancel: (emitEnd?: boolean) => void
  done: Promise<void>
  connectionKey: string
  drivesAsMobile: boolean
}

/** Only phone pairing scope claims mobile presence; the stream is shared by all client kinds. */
export function screencastSubscriberDrivesAsMobile(
  clientKind: 'mobile' | 'runtime' | undefined
): boolean {
  return clientKind === 'mobile'
}

export function resolveBrowserDriverAfterMobileRelease(
  remaining: Iterable<BrowserScreencastSubscriber>
): RuntimeBrowserDriverState {
  let fallback: BrowserScreencastSubscriber | null = null
  for (const subscriber of remaining) {
    if (subscriber.drivesAsMobile) {
      fallback = subscriber
    }
  }
  return fallback ? { kind: 'mobile', clientId: fallback.connectionKey } : { kind: 'idle' }
}
