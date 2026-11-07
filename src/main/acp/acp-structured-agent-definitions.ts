import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/providers/structured-agent-definition'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'

export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

export const ACP_HANDLE_TRANSPORT = 'acp'

const ACP_OPTION_KEYS: ReadonlySet<string> = new Set(['model', 'effort'])

export function isAcpStructuredOptionKey(key: string): boolean {
  return ACP_OPTION_KEYS.has(key)
}

export function acpStructuredAgentDefinition(spec: AcpLaunchSpec): StructuredAgentDefinition {
  const { managedRuntime, hostBackend } = spec
  return {
    agent: spec.agent,
    handleTransport: ACP_HANDLE_TRANSPORT,
    ...spec.account.pin,
    capabilities: {
      // ACP has no stable rewind or goal methods.
      rewind: false,
      // Imported tips need native terminal evidence; Grok's importer does not observe it yet.
      ...(spec.transcriptImport && ['omp', 'opencode', 'opencode2'].includes(spec.agent)
        ? { fork: 'tip' as const }
        : {}),
      compact: spec.compaction === true,
      compactInstructions: spec.compactionInstructions === true,
      threadGoal: false,
      contextUsage: true,
      // Narrowed by each agent's advertised startup capabilities.
      imagePrompts: true,
      steering: 'queue',
      approvalEnforcement: 'orca'
    },
    ...(managedRuntime && { managedRuntime: () => managedRuntime.pin() !== null }),
    ...(hostBackend && { runsHostProgram: (home) => hostBackend.pins(home) }),
    restingOptions: {
      acceptsKey: isAcpStructuredOptionKey,
      // Populate catalogs from live agents.
      fallbackModels: () => null,
      effortDefaultsToModel: false
    }
  }
}
