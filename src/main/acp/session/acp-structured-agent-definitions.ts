import type { StructuredAgentDefinition } from '../../native-chat/agent-session-wire/providers/structured-agent-definition'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import {
  isManagedAgentCli,
  managedAgentCli
} from '../../managed-agent-cli/managed-agent-cli-registry'

export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

export const ACP_HANDLE_TRANSPORT = 'acp'

const ACP_OPTION_KEYS: ReadonlySet<string> = new Set(['model', 'effort'])

export function isAcpStructuredOptionKey(key: string): boolean {
  return ACP_OPTION_KEYS.has(key)
}

export function acpStructuredAgentDefinition(spec: AcpLaunchSpec): StructuredAgentDefinition {
  const { agent, managedRuntime, hostBackend } = spec
  return {
    agent,
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
    ...(isManagedAgentCli(agent) && { managedRuntime: () => managedAgentCli(agent).available() }),
    ...(hostBackend && { runsHostProgram: (home) => hostBackend.pins(home) }),
    restingOptions: {
      acceptsKey: (key) =>
        isAcpStructuredOptionKey(key) ||
        (spec.dialect.fastConfigId !== undefined && key === 'fastMode') ||
        (spec.dialect.contextConfigId !== undefined && key === 'context') ||
        (spec.dialect.interactionModes !== undefined && key === 'interactionMode'),
      // Populate catalogs from live agents.
      fallbackModels: () => null,
      effortDefaultsToModel: false
    }
  }
}
