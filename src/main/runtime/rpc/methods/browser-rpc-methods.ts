import { BROWSER_CORE_METHODS } from './browser/browser-core'
import { BROWSER_IDENTITY_METHODS } from './browser/browser-identity-rpc'
import { BROWSER_EXTRA_METHODS } from './browser/browser-extras'
import { BROWSER_SCREENCAST_METHODS } from './browser/browser-screencast'
import { BROWSER_GRAB_METHODS } from './browser/browser-grab'
import { BROWSER_CLIENT_HOST_METHODS } from './browser/browser-client-host'
import { DESKTOP_BROWSER_BRIDGE_RPC_METHODS } from './browser/desktop-browser-bridge'
import { BROWSER_CLIENT_FILE_CHANNEL_METHODS } from './browser/browser-client-file-channel'
import { BROWSER_NETWORK_TUNNEL_METHODS } from './browser/browser-network-tunnel'

export const BROWSER_RPC_METHODS = [
  ...BROWSER_CORE_METHODS,
  ...BROWSER_IDENTITY_METHODS,
  ...BROWSER_SCREENCAST_METHODS,
  ...BROWSER_GRAB_METHODS,
  ...BROWSER_EXTRA_METHODS,
  ...BROWSER_CLIENT_HOST_METHODS,
  ...DESKTOP_BROWSER_BRIDGE_RPC_METHODS,
  ...BROWSER_CLIENT_FILE_CHANNEL_METHODS,
  ...BROWSER_NETWORK_TUNNEL_METHODS
] as const
