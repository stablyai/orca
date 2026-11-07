import type { WebContents } from 'electron'
import { readPluginFramePartitionKey } from '../../../shared/plugins/frames/plugin-frame-guest'

/**
 * The narrow seam main-window-webview-security.ts calls at window creation, so loading that window
 * never pulls in the plugin guest session graph. plugin-frame-guest-sessions.ts fills the hooks.
 */

export type PluginFrameGuestHooks = {
  /** `will-attach-webview`: partition, origin and plugin must all agree. */
  admit: (partition: string, src: string) => boolean
  /** `did-attach-webview`: installs the guest's policies; false when it is not a plugin guest. */
  attach: (guest: WebContents, host: WebContents) => boolean
}

// Why: Blink resolves rel=dns-prefetch on the system resolver, past the session's proxy and webRequest.
export const PLUGIN_FRAME_GUEST_RENDERER_ARGUMENTS: readonly string[] = [
  '--blink-settings=dnsPrefetchingEnabled=false'
]

let hooks: PluginFrameGuestHooks | null = null

export function setPluginFrameGuestHooks(next: PluginFrameGuestHooks | null): void {
  hooks = next
}

export function isPluginFramePartition(partition: string): boolean {
  return readPluginFramePartitionKey(partition) !== null
}

/** Fails closed until the plugin system has registered its hooks. */
export function admitPluginFrameAttach(partition: string, src: string): boolean {
  return hooks?.admit(partition, src) ?? false
}

export function attachPluginFrameGuest(guest: WebContents, host: WebContents): boolean {
  return hooks?.attach(guest, host) ?? false
}
