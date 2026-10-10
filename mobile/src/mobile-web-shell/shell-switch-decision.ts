import { mobileShellBuildKind } from '../storage/preferences'
import type { BridgeInitRoute } from './bridge/bridge-init-route'

/**
 * Which renderer a hybrid-shell route switch mounts.
 *
 * The build decides, synchronously, so every switch commits its renderer on the first frame: the
 * shell in an OTA build, for a route it could open, and the native screen everywhere else.
 */
export type ShellSwitchDecision =
  | { readonly kind: 'native' }
  | { readonly kind: 'shell'; readonly route: BridgeInitRoute }

/** The route is `null` when this switch's params name no screen the shell could open. */
export function shellSwitchDecision(route: BridgeInitRoute | null): ShellSwitchDecision {
  return route !== null && mobileShellBuildKind() === 'ota'
    ? { kind: 'shell', route }
    : { kind: 'native' }
}
