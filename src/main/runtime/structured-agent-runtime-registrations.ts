// Each runtime registration owns its adapter, location support and account resolution at start.

import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
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
import { readClaudeManagedAccountGateSettings } from '../native-chat/claude-structured-managed-account-support'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  createNativeChatVisualsDelivery,
  type PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
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
  createAcpStructuredLaunchResolver,
  resolveAcpLaunchCommand
} from '../acp/acp-structured-launch-resolution'
import { AcpStructuredSessionAdapter } from '../acp/acp-structured-session-adapter'
import { PI_RPC_RUNTIME_REGISTRATION } from '../pi/rpc-runtime-registration'

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

export type StructuredAgentRuntimeRegistration = {
  definition: StructuredAgentDefinition
  createAdapter: (context: StructuredAgentAdapterContext) => StructuredAgentRuntimeAdapter
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

function nativeChatVisualsFor(deps: StructuredAgentSessionRuntimeDeps): {
  prepareVisuals?: PrepareNativeChatVisuals
} {
  return deps.nativeChatVisuals
    ? {
        prepareVisuals: createNativeChatVisualsDelivery({
          stateDirectory: deps.stateDirectory,
          logger: deps.logger,
          isEnabled: deps.nativeChatVisuals.isEnabled
        })
      }
    : {}
}

function createCodexAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps, store, followUps, host } = context
  return new CodexStructuredSessionAdapter({
    resolveAccountKind: deps.resolveCodexAccountKind,
    resolveLaunch: createCodexStructuredLaunchResolver({
      store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: context.environment.resolveCodexEnvironment,
      resolveLaunchArgs: () => deps.resolveLaunchArgs('codex'),
      ...(deps.resolveCodexPermissionPolicy
        ? { resolvePermissionPolicy: deps.resolveCodexPermissionPolicy }
        : {}),
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {}),
      ...nativeChatVisualsFor(deps)
    }),
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
  return createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
    ...(deps.claudeCliFlags ? { claudeCliFlags: deps.claudeCliFlags } : {}),
    ...nativeChatVisualsFor(deps),
    ...(deps.resolveClaudeLaunchEnv ? { resolveClaudeLaunchEnv: deps.resolveClaudeLaunchEnv } : {}),
    resolveClaudeInheritedEnv: context.environment.resolveClaudeInheritedEnv,
    resolveClaudeLaunchArgs: () => deps.resolveLaunchArgs('claude'),
    resolveClaudeAuthPolicy: deps.resolveClaudeAuthPolicy,
    ...(deps.resolveClaudePermissionMode
      ? { resolveClaudePermissionMode: deps.resolveClaudePermissionMode }
      : {}),
    ...(deps.getClaudeManagedAccountGateSettings
      ? {
          readClaudeManagedAccountGate: () =>
            readClaudeManagedAccountGateSettings(deps.getClaudeManagedAccountGateSettings!)
        }
      : {}),
    attachmentDirectory: agentSessionAttachmentStoreRoot(deps.stateDirectory),
    onLifecycleEvent: context.deliverLifecycle,
    logger: deps.logger,
    onChildWorkEvidence: (sessionId, evidence) =>
      host()?.publishChildWorkEvidence(sessionId, evidence),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    onSessionIdle: followUps.releaseUnansweredDispatches,
    ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore
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
    createAdapter: (context) => {
      const { deps, store, followUps } = context
      const readJournal = (sessionId: string) =>
        replayJournal(context.journalDatabase.db, sessionId)
      return new AcpStructuredSessionAdapter({
        spec,
        readJournal,
        resolveLaunch: createAcpStructuredLaunchResolver(spec, {
          store,
          readJournal,
          resolveWorkspacePath: deps.resolveWorkspacePath,
          resolveEnvironment: context.environment.resolveBaseEnvironment,
          ...(deps.resolveAgentLaunchEnv ? { resolveLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
          ...(deps.resolveAgentCommandSettings
            ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
            : {}),
          ...(deps.resolveAgentFullAccess
            ? { resolveFullAccess: deps.resolveAgentFullAccess }
            : {}),
          ...nativeChatVisualsFor(deps),
          logger: deps.logger
        }),
        connect: (launch, options) => createAcpAgentConnection(launch, options),
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
