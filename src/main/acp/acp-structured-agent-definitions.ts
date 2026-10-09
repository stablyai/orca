import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../shared/tui-agent-config'

export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

/** Every ACP agent's handles live in one protocol's id space; the agent part keeps them apart. */
export const ACP_HANDLE_TRANSPORT = 'acp'

/** Session options an ACP agent takes: its model, and the model's reasoning effort. */
const ACP_OPTION_KEYS: ReadonlySet<string> = new Set(['model', 'effort'])

export function isAcpStructuredOptionKey(key: string): boolean {
  return ACP_OPTION_KEYS.has(key)
}

/** What the host knows about an ACP agent before any of its sessions runs. */
export function acpStructuredAgentDefinition(spec: AcpLaunchSpec): StructuredAgentDefinition {
  return {
    agent: spec.agent,
    handleTransport: ACP_HANDLE_TRANSPORT,
    ...spec.account.pin,
    capabilities: {
      // ACP has no stable rewind or goal method; a command arrives through `/` instead.
      rewind: false,
      compact: spec.compaction === true,
      threadGoal: false,
      contextUsage: true,
      // An agent that does not also advertise images at its start has a message with one refused.
      imagePrompts: spec.imagePrompts === true,
      steering: 'queue',
      // Orca answers every permission request the agent sends; the agent decides when it asks.
      approvalEnforcement: 'orca'
    },
    restingOptions: {
      acceptsKey: isAcpStructuredOptionKey,
      // The agent lists its models over the protocol once it runs; Orca keeps no list of its own.
      fallbackModels: () => null,
      effortDefaultsToModel: false
    }
  }
}
