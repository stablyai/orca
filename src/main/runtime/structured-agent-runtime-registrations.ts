import { withSupportedCodexCli } from '../codex/codex-cli-installation-error'
import { codexStructuredLaunchPart } from '../codex/codex-structured-launch-resolution'
import { claudeStructuredLaunchPart } from '../claude/claude-structured-launch-resolution'
import { createClaudeCommandCatalogProbe } from '../claude/claude-command-catalog-probe'
import { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { createCodexAtRestSkillCatalog } from '../codex/codex-at-rest-skills-probe'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { replayJournal } from '../native-chat/agent-session-journal/journal-open'
import { createStructuredClaudeRuntimeAdapter } from './structured-claude-runtime-adapter'
import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import { createAcpAgentConnection } from '../acp/acp-agent-connection'
import { acpStructuredLaunchPart } from '../acp/acp-structured-launch-resolution'
import { AcpStructuredSessionAdapter } from '../acp/acp-structured-session-adapter'
import { PI_RPC_RUNTIME_REGISTRATION } from '../pi/rpc-runtime-registration'
import {
  claudeLaunchEnvOverlay,
  claudeListingDeps
} from './structured-agent-model-catalog-discovery'
import {
  composeStructuredLaunch,
  composeStructuredLaunchRead,
  structuredAgentLaunchSources
} from './structured-agent-launch-composition'
import {
  STRUCTURED_AGENT_RUNTIME_CATALOG,
  type StructuredAgentRuntimeCatalogEntry
} from './structured-agent-runtime-metadata'
import type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentRuntimeRegistration
} from './structured-agent-runtime-registration-types'

export type {
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter,
  StructuredAgentAccountHomeRequest,
  StructuredAgentAccountHomeServices,
  StructuredAgentModelCatalogContext,
  StructuredAgentLaunchCheck,
  StructuredAgentRuntimeRegistration
} from './structured-agent-runtime-registration-types'

function createCodexAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps, followUps, host } = context
  return new CodexStructuredSessionAdapter({
    resolveAccountKind: deps.resolveCodexAccountKind,
    atRestCommands: createCodexAtRestSkillCatalog({
      resolveLaunchArgs: () => deps.resolveLaunchArgs('codex'),
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment: () => context.environment.resolveAgentEnvironment('codex'),
      refreshEnvironmentAfterMiss: context.environment.refreshAfterMissingProgram,
      ...(deps.prepareCodexCatalogProbeHome
        ? { prepareHome: deps.prepareCodexCatalogProbeHome }
        : {}),
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
    }),
    resolveLaunch: withSupportedCodexCli(
      composeStructuredLaunch(
        CODEX_STRUCTURED_AGENT,
        structuredAgentLaunchSources(context),
        codexStructuredLaunchPart({
          resolveLaunchArgs: () => deps.resolveLaunchArgs('codex'),
          ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
        })
      ),
      deps.readCodexInstallation
    ),
    ...(deps.openCodexConnection ? { openConnection: deps.openCodexConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    modelCatalog: agentModelCatalogStore,
    readModelCatalog: (sessionId, verifiedOnly) =>
      host()?.deps.modelCatalog?.peek(sessionId, verifiedOnly) ?? null,
    demandModelCatalog: async (sessionId, legacy) =>
      host()?.deps.modelCatalog?.read({
        agent: 'codex',
        sessionId,
        ...(legacy ? { legacy: true } : {})
      }),
    onChildWorkEvidence: (sessionId, evidence, producer) =>
      host()?.publishChildWorkEvidence(sessionId, evidence, producer),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    // After the frame being read: what the child holds is re-derived, never published mid-frame.
    onHeldSendsChanged: ({ sessionId }) =>
      queueMicrotask(() => host()?.publishWorkChanged(sessionId)),
    logger: deps.logger,
    onEvent: (event) => {
      // Every exit, expected or not: the host ends that child's record.
      if (event.type === 'options-reported' || (event.type === 'ended' && 'cause' in event)) {
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
  const resolveAccountHome = deps.resolveAgentAccountHome
  return createStructuredClaudeRuntimeAdapter({
    store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    ...(resolveAccountHome ? { resolveAccountHome: () => resolveAccountHome('claude') } : {}),
    resolveLaunch: composeStructuredLaunch(
      CLAUDE_STRUCTURED_AGENT,
      structuredAgentLaunchSources(context),
      claudeStructuredLaunchPart({
        resolveLaunchArgs: () => deps.resolveLaunchArgs('claude'),
        ...(deps.resolveClaudeCommand ? { resolveCommand: deps.resolveClaudeCommand } : {}),
        resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
        attachmentDirectory: agentSessionAttachmentStoreRoot(deps.stateDirectory),
        ...(deps.claudeCliFlags ? { cliFlags: deps.claudeCliFlags } : {})
      })
    ),
    ...(deps.resolveClaudeCommand ? { resolveClaudeCommand: deps.resolveClaudeCommand } : {}),
    ...(deps.claudeCliFlags ? { claudeCliFlags: deps.claudeCliFlags } : {}),
    ...(overlay ? { resolveClaudeLaunchEnv: overlay } : {}),
    resolveClaudeInheritedEnv: context.environment.resolveBaseEnvironment,
    atRestCommandProbe: createClaudeCommandCatalogProbe(claudeListingDeps(context)),
    onLifecycleEvent: context.deliverLifecycle,
    logger: deps.logger,
    onChildWorkEvidence: (sessionId, evidence, producer) =>
      host()?.publishChildWorkEvidence(sessionId, evidence, producer),
    onDispatchSettledLate: followUps.onDispatchSettledLate,
    ...(deps.openClaudeConnection ? { openClaudeConnection: deps.openClaudeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
  })
}

function createAcpAdapter(
  spec: AcpLaunchSpec
): StructuredAgentRuntimeRegistration['createAdapter'] {
  return (context) => {
    const { deps, followUps } = context
    const readJournal = (sessionId: string) => replayJournal(context.journalDatabase.db, sessionId)
    const definition = acpStructuredAgentDefinition(spec)
    const sources = structuredAgentLaunchSources(context)
    const part = acpStructuredLaunchPart(spec, {
      readJournal,
      ...deps.acpLaunchCommand,
      dataDirectory: deps.stateDirectory,
      logger: deps.logger
    })
    return new AcpStructuredSessionAdapter({
      spec,
      resolveLaunch: composeStructuredLaunch(definition, sources, part),
      readLaunch: composeStructuredLaunchRead(definition, sources, part),
      dataDirectory: deps.stateDirectory,
      resolveLaunchArgs: () => deps.resolveLaunchArgs(spec.agent),
      connect: deps.openAcpConnection ?? createAcpAgentConnection,
      onChildWorkEvidence: (sessionId, evidence, producer) =>
        context.host()?.publishChildWorkEvidence(sessionId, evidence, producer),
      ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
      onDispatchSettledLate: followUps.onDispatchSettledLate,
      logger: deps.logger,
      onEvent: context.deliverLifecycle
    })
  }
}

function registrationWithAdapter(
  entry: StructuredAgentRuntimeCatalogEntry
): StructuredAgentRuntimeRegistration {
  // Keep overrides visible through both the metadata and full-registration views.
  switch (entry.kind) {
    case 'pi':
      return PI_RPC_RUNTIME_REGISTRATION
    case 'codex':
      return Object.assign(entry.metadata, { createAdapter: createCodexAdapter })
    case 'claude':
      return Object.assign(entry.metadata, { createAdapter: createClaudeAdapter })
    case 'acp':
      return Object.assign(entry.metadata, { createAdapter: createAcpAdapter(entry.spec) })
  }
}

export const STRUCTURED_AGENT_RUNTIME_REGISTRATIONS: readonly StructuredAgentRuntimeRegistration[] =
  STRUCTURED_AGENT_RUNTIME_CATALOG.map(registrationWithAdapter)

/** The registration of `agent`; null for an agent this runtime does not drive. */
export function structuredAgentRuntimeRegistration(
  agent: string
): StructuredAgentRuntimeRegistration | null {
  return (
    STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.find(({ definition }) => definition.agent === agent) ??
    null
  )
}
