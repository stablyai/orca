// Each runtime registration owns its adapter, location support and account resolution at start.

import { codexStructuredLaunchPart } from '../codex/codex-structured-launch-resolution'
import { claudeStructuredLaunchPart } from '../claude/claude-structured-launch-resolution'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import { supportsClaudeStructuredLocation } from '../claude/claude-structured-location-support'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { applyStructuredCodexWorkspaceTrust } from '../agent-workspace-trust-spawn'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  agentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import {
  isAgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionLifecycleEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { replayJournal } from '../native-chat/agent-session-journal/journal-open'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'
import type { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import {
  resolveStructuredClaudeAccountHomePath,
  resolveStructuredCodexAccountHomePath,
  type StructuredClaudeAccountHomeDeps,
  type StructuredCodexAccountHomeDeps
} from './structured-agent-account-home'
import { ACP_LAUNCH_SPECS, type AcpLaunchSpec } from '../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import { createAcpAgentConnection } from '../acp/acp-agent-connection'
import {
  acpLaunchVersionSupported,
  acpStructuredLaunchPart,
  resolveAcpLaunchCommand
} from '../acp/acp-structured-launch-resolution'
import { AcpStructuredSessionAdapter } from '../acp/acp-structured-session-adapter'
import { PI_RPC_RUNTIME_REGISTRATION } from '../pi/rpc-runtime-registration'
import type { AgentModelCatalogDiscovery } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import {
  acpModelCatalogDiscovery,
  claudeLaunchEnvOverlay,
  claudeModelCatalogDiscovery,
  codexModelCatalogDiscovery
} from './structured-agent-model-catalog-discovery'
import {
  composeStructuredLaunch,
  composeStructuredLaunchRead,
  structuredAgentLaunchSources
} from './structured-agent-launch-composition'

/** What an agent's adapter is built from: the open store and the runtime around it. */
export type StructuredAgentAdapterContext = {
  deps: StructuredAgentSessionRuntimeDeps
  store: AgentSessionRecordStore
  journalDatabase: JournalHostDatabase
  environment: ReturnType<typeof createStructuredAgentEnvironmentResolvers>
  /** Hands the host an exit or other lifecycle event the agent observed. */
  deliverLifecycle: (event: StructuredAgentSessionLifecycleEvent) => void
  followUps: ReturnType<typeof createStructuredAgentSessionDispatchFollowUps>
  /** Null until the host is built: the adapters are built first. */
  host: () => StructuredAgentSessionHost | null
}

export type StructuredAgentRuntimeAdapter = StructuredAgentSessionAdapter & {
  closeAll: () => Promise<void>
  /** Resolves once exits the agent observed have been published; absent when it publishes at once. */
  drainObservedExits?: () => Promise<void>
}

/** Which account home a chat of an agent pins, asked on the host that runs it. */
export type StructuredAgentAccountHomeRequest = {
  launchEnv: NodeJS.ProcessEnv
  /** Where the chat runs; null for a read with no workspace (the model catalog). */
  location: AgentSessionExecutionLocation | null
  /** A `read` has no side effects: it syncs no home, starts no bridge, clears no selection. */
  purpose: 'launch' | 'read'
  /** The launch's workspace directory on this host; a read has none. */
  workspacePath: (() => Promise<string>) | null
}

/** What resolving an account may ask of the runtime around it. */
export type StructuredAgentAccountHomeServices = {
  getClaudeConfigDirectory: StructuredClaudeAccountHomeDeps['getClaudeConfigDirectory']
  /** Codex's home for a launch, prepared for it; and the same answer with no side effects. */
  prepareCodexLaunchHome: StructuredCodexAccountHomeDeps['resolveLaunchHome']
  readCodexLaunchHome: StructuredCodexAccountHomeDeps['resolveLaunchHome']
  workspaceTrustSettings: () => Parameters<typeof applyStructuredCodexWorkspaceTrust>[0]['settings']
}

/** What a catalog probe is built from: the same runtime resolvers its sessions launch through. */
export type StructuredAgentModelCatalogContext = Pick<
  StructuredAgentAdapterContext,
  'deps' | 'environment'
>

export type StructuredAgentRuntimeRegistration = {
  definition: StructuredAgentDefinition
  createAdapter: (context: StructuredAgentAdapterContext) => StructuredAgentRuntimeAdapter
  /** How this agent's models are listed before any session of it runs. Required: an agent that
   *  cannot list says so, rather than being left out of the shared catalog. */
  modelCatalog: (context: StructuredAgentModelCatalogContext) => AgentModelCatalogDiscovery
  /** Whether this agent's chats can run at `location`; answered without building the host. */
  supportsLocation: (location: AgentSessionExecutionLocation) => boolean
  /** Whether the agent installed on this host runs a structured chat, asked at create with the
   *  environment a launch starts from; absent when the location alone decides. */
  supportsLaunch?: (input: {
    cwd: string
    env: Record<string, string>
    commandSettings: StructuredAgentCommandSettings
  }) => Promise<boolean>
  /** The account a chat of this agent pins; see `StructuredAgentAccountHomeRequest`. */
  resolveAccountHome: (
    request: StructuredAgentAccountHomeRequest,
    services: StructuredAgentAccountHomeServices
  ) => Promise<AgentSessionAccountHome>
}

function createCodexAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps, followUps, host } = context
  return new CodexStructuredSessionAdapter({
    resolveAccountKind: deps.resolveCodexAccountKind,
    resolveLaunch: composeStructuredLaunch(
      CODEX_STRUCTURED_AGENT,
      structuredAgentLaunchSources(context),
      codexStructuredLaunchPart({
        resolveLaunchArgs: () => deps.resolveLaunchArgs('codex'),
        ...(deps.resolveCodexPermissionPolicy
          ? { resolvePermissionPolicy: deps.resolveCodexPermissionPolicy }
          : {}),
        ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
      })
    ),
    ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore,
    onChildWorkEvidence: (sessionId, evidence) =>
      host()?.publishChildWorkEvidence(sessionId, evidence),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    onPrimaryThreadStoppedRunning: followUps.releaseUnansweredDispatches,
    logger: deps.logger,
    onEvent: (event) => {
      // Every exit, expected or not: the host ends that child's record.
      if (event.type === 'ended' && 'cause' in event) {
        context.deliverLifecycle(event)
      }
    }
  })
}

function createClaudeAdapter(
  context: StructuredAgentAdapterContext
): StructuredAgentRuntimeAdapter {
  const { deps, store, followUps, host } = context
  const overlay = claudeLaunchEnvOverlay(deps).resolveEnv
  return createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    resolveLaunch: composeStructuredLaunch(
      CLAUDE_STRUCTURED_AGENT,
      structuredAgentLaunchSources(context),
      claudeStructuredLaunchPart({
        resolveLaunchArgs: () => deps.resolveLaunchArgs('claude'),
        ...(deps.resolveClaudeCommand ? { resolveCommand: deps.resolveClaudeCommand } : {}),
        resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
        ...(deps.resolveClaudePermissionMode
          ? { resolvePermissionMode: deps.resolveClaudePermissionMode }
          : {}),
        attachmentDirectory: agentSessionAttachmentStoreRoot(deps.stateDirectory),
        ...(deps.claudeCliFlags ? { cliFlags: deps.claudeCliFlags } : {})
      })
    ),
    ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
    ...(deps.claudeCliFlags ? { claudeCliFlags: deps.claudeCliFlags } : {}),
    ...(overlay ? { resolveClaudeLaunchEnv: overlay } : {}),
    resolveClaudeInheritedEnv: context.environment.resolveBaseEnvironment,
    onLifecycleEvent: context.deliverLifecycle,
    logger: deps.logger,
    onChildWorkEvidence: (sessionId, evidence) =>
      host()?.publishChildWorkEvidence(sessionId, evidence),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    onSessionIdle: followUps.releaseUnansweredDispatches,
    ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
  })
}

function acpRegistration(spec: AcpLaunchSpec): StructuredAgentRuntimeRegistration {
  return {
    definition: acpStructuredAgentDefinition(spec),
    supportsLocation: (location) => supportsSupervisedProviderChildLocation(location),
    ...(spec.supportsVersion
      ? {
          supportsLaunch: async ({ cwd, env, commandSettings }) => {
            const launchEnv = { ...env, ...spec.env }
            let command: string
            try {
              command = resolveAcpLaunchCommand(spec, launchEnv, { commandSettings })
            } catch (error) {
              // An unrunnable Command setting is the launch's refusal to state, not a terminal.
              if (isAgentSessionPreSpawnError(error)) {
                return true
              }
              throw error
            }
            return acpLaunchVersionSupported(spec, { command, cwd, env: launchEnv })
          }
        }
      : {}),
    resolveAccountHome: ({ launchEnv }) => spec.account.resolve({ launchEnv }),
    modelCatalog: (context) => acpModelCatalogDiscovery(spec, context),
    createAdapter: (context) => {
      const { deps, followUps } = context
      const readJournal = (sessionId: string) =>
        replayJournal(context.journalDatabase.db, sessionId)
      const definition = acpStructuredAgentDefinition(spec)
      const sources = structuredAgentLaunchSources(context)
      const part = acpStructuredLaunchPart(spec, {
        readJournal,
        ...(deps.resolveAgentFullAccess ? { resolveFullAccess: deps.resolveAgentFullAccess } : {}),
        logger: deps.logger
      })
      return new AcpStructuredSessionAdapter({
        spec,
        readJournal,
        resolveLaunch: composeStructuredLaunch(definition, sources, part),
        readLaunch: composeStructuredLaunchRead(definition, sources, part),
        connect: (launch, options) => createAcpAgentConnection(launch, options),
        onChildWorkEvidence: (sessionId, evidence) =>
          context.host()?.publishChildWorkEvidence(sessionId, evidence),
        ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
        onDispatchSettledLate: followUps.onDispatchSettledLate,
        logger: deps.logger,
        // Every exit, expected or not: the host ends that child's record.
        onEvent: (event) => {
          if (event.type === 'ended') {
            context.deliverLifecycle(event)
          }
        }
      })
    }
  }
}

async function resolveCodexAccountHomePath(
  request: StructuredAgentAccountHomeRequest,
  services: StructuredAgentAccountHomeServices
): Promise<string> {
  const { launchEnv, purpose, workspacePath } = request
  if (purpose === 'launch' && workspacePath) {
    await applyStructuredCodexWorkspaceTrust({
      workspacePath: await workspacePath(),
      launchEnv,
      settings: services.workspaceTrustSettings()
    })
  }
  return resolveStructuredCodexAccountHomePath({
    launchEnv,
    resolveLaunchHome:
      purpose === 'launch' ? services.prepareCodexLaunchHome : services.readCodexLaunchHome
  })
}

export const STRUCTURED_AGENT_RUNTIME_REGISTRATIONS: readonly StructuredAgentRuntimeRegistration[] =
  [
    PI_RPC_RUNTIME_REGISTRATION,
    {
      definition: CODEX_STRUCTURED_AGENT,
      createAdapter: createCodexAdapter,
      modelCatalog: codexModelCatalogDiscovery,
      supportsLocation: (location) => supportsCodexStructuredLocation(location),
      resolveAccountHome: async (request, services) =>
        agentSessionAccountHome(
          CODEX_STRUCTURED_AGENT,
          await resolveCodexAccountHomePath(request, services)
        )
    },
    {
      definition: CLAUDE_STRUCTURED_AGENT,
      createAdapter: createClaudeAdapter,
      modelCatalog: claudeModelCatalogDiscovery,
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
    },
    ...ACP_LAUNCH_SPECS.map(acpRegistration)
  ]

/** The registration of `agent`; null for an agent this runtime does not drive. */
export function structuredAgentRuntimeRegistration(
  agent: string
): StructuredAgentRuntimeRegistration | null {
  return (
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.find(({ definition }) => definition.agent === agent) ??
    null
  )
}
