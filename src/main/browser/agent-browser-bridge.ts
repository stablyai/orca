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

export class AgentBrowserBridge extends AgentBrowserBridgeStateCommands {}
