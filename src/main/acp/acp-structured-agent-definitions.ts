import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { AcpLaunchSpec } from './acp-launch-specs'

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
    accountHomeVariable: spec.accountHomeVariable,
    capabilities: {
      // ACP has no stable rewind, compact or goal method; a command arrives through `/` instead.
      rewind: false,
      compact: false,
      threadGoal: false,
      contextUsage: true,
      // Off: Orca sends text prompts only until ACP image prompts have a path.
      imagePrompts: false,
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
