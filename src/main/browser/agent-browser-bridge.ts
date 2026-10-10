import { AgentBrowserBridgeStateCommands } from './agent-browser-bridge-state-commands'

export {
  AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES,
  AGENT_BROWSER_CLIPBOARD_WRITE_MAX_BYTES
} from './agent-browser-bridge-types'
export type {
  BrowserMouseModifier,
  AgentBrowserCleanupOptions,
  AgentBrowserBridgeOptions
} from './agent-browser-bridge-types'

/**
 * Routes automation commands to the browser guest registered for the selected tab.
 *
 * The implementation is layered by responsibility (tab targeting, command queue,
 * session lifecycle, and command families) so each layer stays independently
 * reviewable while preserving this public facade.
 */
export class AgentBrowserBridge extends AgentBrowserBridgeStateCommands {}
