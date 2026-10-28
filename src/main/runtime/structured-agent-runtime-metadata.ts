import { agentSessionAccountHome } from '../../shared/agent-session-account-home'
import { applyStructuredCodexWorkspaceTrust } from '../agent-workspace-trust-spawn'
import { ACP_LAUNCH_SPECS, type AcpLaunchSpec } from '../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import { resolveAcpLaunchCommand } from '../acp/acp-structured-launch-resolution'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { CLAUDE_CLI_CONVERSATIONS } from '../claude/claude-cli-conversations'
import { CODEX_CLI_CONVERSATIONS } from '../codex/codex-cli-conversations'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import { supportsClaudeStructuredLocation } from '../claude/claude-structured-location-support'
import { supportsAcpStructuredLocation } from '../acp/acp-structured-location-support'
import { PI_RPC_RUNTIME_METADATA } from '../pi/rpc-runtime-metadata'
import {
  resolveStructuredClaudeAccountHomePath,
  resolveStructuredCodexAccountHomePath
} from './structured-agent-account-home'
import {
  acpModelCatalogDiscovery,
  claudeModelCatalogDiscovery,
  codexModelCatalogDiscovery
} from './structured-agent-model-catalog-discovery'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type {
  StructuredAgentAccountHomeRequest,
  StructuredAgentChatProgram,
  StructuredAgentAccountHomeServices,
  StructuredAgentRuntimeMetadata
} from './structured-agent-runtime-registration-types'

export type StructuredAgentRuntimeCatalogEntry =
  | { kind: 'pi' | 'codex' | 'claude'; metadata: StructuredAgentRuntimeMetadata }
  | { kind: 'acp'; metadata: StructuredAgentRuntimeMetadata; spec: AcpLaunchSpec }

// Why the host's data folder: a start runs Orca's installed release before PATH.
function acpChatProgram(spec: AcpLaunchSpec): StructuredAgentChatProgram {
  const { managedRuntime } = spec
  return {
    resolve: (shellEnv, commandSettings) => {
      const env = { ...shellEnv, ...spec.env }
      const options = { commandSettings, dataDirectory: getProfileUserDataPath() }
      return { command: resolveAcpLaunchCommand(spec, env, options), env }
    },
    ...(managedRuntime ? { installable: () => managedRuntime.pin() !== null } : {})
  }
}

function cliChatProgram(agent: 'claude' | 'codex'): StructuredAgentChatProgram {
  return {
    resolve: (env, commandSettings) => {
      const homePath = env.HOME ?? env.USERPROFILE
      const pathEnv = env.PATH ?? env.Path ?? null
      const options = { pathEnv, ...(homePath ? { homePath } : {}) }
      return { command: resolveStructuredAgentCommand(agent, commandSettings, options), env }
    }
  }
}

function acpMetadata(spec: AcpLaunchSpec): StructuredAgentRuntimeMetadata {
  const { minimumVersions } = spec
  return {
    definition: acpStructuredAgentDefinition(spec),
    chatProgram: acpChatProgram(spec),
    supportsLocation: (location) => supportsAcpStructuredLocation(spec, location),
    ...(minimumVersions
      ? {
          launchCheck: {
            resolveLaunch: (shellEnv, commandSettings) => {
              const env = { ...shellEnv, ...spec.env }
              const command = resolveAcpLaunchCommand(spec, env, {
                commandSettings,
                dataDirectory: null
              })
              return { command, env }
            },
            minimumVersions
          }
        }
      : {}),
    resolveAccountHome: ({ launchEnv }, { stateDirectory }) =>
      spec.account.resolve({ launchEnv, stateDirectory }),
    modelCatalog: (context) => acpModelCatalogDiscovery(spec, context),
    transcriptImport: spec.transcriptImport,
    sessionHistory: spec.sessionHistory
  }
}

async function resolveCodexAccountHomePath(
  request: StructuredAgentAccountHomeRequest,
  services: StructuredAgentAccountHomeServices
): Promise<string> {
  const { launchEnv, purpose, workspacePath } = request
  const codexHome = await resolveStructuredCodexAccountHomePath({
    launchEnv,
    conversationHome: request.conversationHome,
    resolveLaunchHome:
      purpose === 'launch' ? services.prepareCodexLaunchHome : services.readCodexLaunchHome
  })
  if (purpose === 'launch' && workspacePath) {
    await applyStructuredCodexWorkspaceTrust({
      workspacePath: await workspacePath(),
      launchEnv,
      codexHome,
      settings: services.workspaceTrustSettings()
    })
  }
  return codexHome
}

// One roster supplies both metadata readers and the host's synchronous adapter factories.
export const STRUCTURED_AGENT_RUNTIME_CATALOG: readonly StructuredAgentRuntimeCatalogEntry[] = [
  { kind: 'pi', metadata: PI_RPC_RUNTIME_METADATA },
  {
    kind: 'codex',
    metadata: {
      definition: CODEX_STRUCTURED_AGENT,
      chatProgram: cliChatProgram('codex'),
      modelCatalog: codexModelCatalogDiscovery,
      ...CODEX_CLI_CONVERSATIONS,
      supportsLocation: (location) => supportsCodexStructuredLocation(location),
      resolveAccountHome: async (request, services) =>
        agentSessionAccountHome(
          CODEX_STRUCTURED_AGENT,
          await resolveCodexAccountHomePath(request, services)
        )
    }
  },
  {
    kind: 'claude',
    metadata: {
      definition: CLAUDE_STRUCTURED_AGENT,
      chatProgram: cliChatProgram('claude'),
      modelCatalog: claudeModelCatalogDiscovery,
      ...CLAUDE_CLI_CONVERSATIONS,
      supportsLocation: supportsClaudeStructuredLocation,
      resolveAccountHome: async ({ launchEnv, location }, services) =>
        agentSessionAccountHome(
          CLAUDE_STRUCTURED_AGENT,
          resolveStructuredClaudeAccountHomePath({
            launchEnv,
            wslDistro: location?.wslDistro ?? null,
            getClaudeConfigDirectory: services.getClaudeConfigDirectory
          })
        )
    }
  },
  ...ACP_LAUNCH_SPECS.map((spec): StructuredAgentRuntimeCatalogEntry => ({
    kind: 'acp',
    metadata: acpMetadata(spec),
    spec
  }))
]

export const STRUCTURED_AGENT_RUNTIME_METADATA: readonly StructuredAgentRuntimeMetadata[] =
  STRUCTURED_AGENT_RUNTIME_CATALOG.map(({ metadata }) => metadata)

/** The metadata of `agent`, without constructing its adapter or installing the host. */
export function structuredAgentRuntimeMetadata(
  agent: string
): StructuredAgentRuntimeMetadata | null {
  return (
    STRUCTURED_AGENT_RUNTIME_METADATA.find(({ definition }) => definition.agent === agent) ?? null
  )
}
