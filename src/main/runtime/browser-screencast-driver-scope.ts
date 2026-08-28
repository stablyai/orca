import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'

/** One live browser screencast subscription, tracked per browser page. */
export type BrowserScreencastSubscriber = {
  cancel: (emitEnd?: boolean) => void
  done: Promise<void>
  connectionKey: string
  /** Whether this subscriber owns the page's mobile presence lock. */
  drivesAsMobile: boolean
}

/**
 * Why: `browser.screencast` is the one stream desktop, web, CLI and phone clients all share, so the
 * subscriber's pairing scope — not the fact that it subscribed — decides who takes the presence lock.
 * In-process callers report no scope and never drive.
 */
export function screencastSubscriberDrivesAsMobile(
  clientKind: 'mobile' | 'runtime' | undefined
): boolean {
  return clientKind === 'mobile'
}

/** The driver a page falls back to once the mobile subscriber holding its lock goes away. */
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
