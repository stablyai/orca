import type { HostOs } from './host-os'

export type { HostOs } from './host-os'

/**
 * Web sibling: `Platform.OS` is `web` inside the shell's page, but the keyboard it lifts over is the
 * phone's, whose height the shell reports in that OS's own terms. So the page answers the phone's
 * OS from the WebView's user agent. iPadOS reports a Mac, which only its touch points give away.
 */
export function hostOs(): HostOs {
  const agent = globalThis.navigator?.userAgent ?? ''
  if (/iP(ad|hone|od)/.test(agent)) {
    return 'ios'
  }
  if (globalThis.navigator?.platform === 'MacIntel' && globalThis.navigator.maxTouchPoints > 1) {
    return 'ios'
  }
  return agent.includes('Android') ? 'android' : 'web'
}
