// Compose shared admission, cwd, environment, visuals and child sealing; agent parts add only agent-specific inputs and never set cwd/sealed env.

import type { ReadOnlySessionMode } from '../../../bots/bot-look-around-policy'
import { SessionMcpTools } from '../../../mcp-servers/session-mcp-tools'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { isNativeLocalLocation } from '../../../../shared/execution-host/execution-host'
import type { StructuredAgentDefinition } from '../../../native-chat/agent-session-wire/providers/structured-agent-definition'
import { agentDrivesSession } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-provider-support'
import type { StructuredAgentCommandSettings } from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import {
  createNativeChatVisualsDelivery,
  type NativeChatVisualsLaunch,
  type PrepareNativeChatVisuals
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import { resolveAgentSessionLaunchDirectory } from './agent-session-launch-directory'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import type { StructuredAgentAdapterContext } from '../installation/structured-agent-runtime-registration-types'
import {
  sealStructuredSessionChild,
  STRUCTURED_CHILD_ENV_TO_DELETE
} from '../environment/structured-session-child-env'
import { type LinkedSkills, NO_LINKED_SKILLS } from '../../../native-chat/native-chat-skill-roots'

/** Where a launch's shared inputs come from. */
export type StructuredAgentLaunchSources = {
  store: Pick<
    AgentSessionRecordStore,
    'selectWritableRecord' | 'requireWritableRecord' | 'pinLaunchDirectory'
  >
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveBaseEnvironment: () => Promise<Record<string, string>>
  /** The base environment with the user's overlay for `agent` laid over it. */
  resolveAgentEnvironment: (agent: string) => Promise<Record<string, string>>
  /** The user's per-agent environment overlay from settings. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  prepareVisuals?: PrepareNativeChatVisuals
  /** Standing instructions the agent's own system prompt carries for this session; null adds none. */
  resolveInstructions?: (
    record: AgentSessionRecord,
    launchDirectory: string,
    /** How to use the linked projects' skills, as `linkedSkillsSection` writes it; null for none. */
    linkedSkills: string | null,
    /** See `StructuredAgentDefinition.instructionsEachStart`. */
    eachStart: boolean
  ) => Promise<string | null>
  /** Rereads the base environment after a lookup that started at `askedAt` found no program in
   *  it; absent never retries. */
  refreshAfterMissingProgram?: (askedAt: number) => Promise<void>
  /** How a session may only read (a bot's look-around or tidy-up); absent or null: it isn't. */
  readOnlySession?: (sessionId: string) => ReadOnlySessionMode | null
  /** Work every launch of this session waits for, read-only ones too; a rejection stops the launch. */
  prepareLaunch?: (record: AgentSessionRecord, launchDirectory: string) => Promise<void>
  /** The MCP servers Orca adds to the session: a bot's own, and the host's list; absent adds none. */
  resolveToolServers?: (
    record: AgentSessionRecord,
    launchDirectory: string
  ) => Promise<SessionMcpTools>
  /** A bot's linked-skills folder and the projects in it, scanned for this launch; absent: none. */
  resolveLinkedSkills?: (record: AgentSessionRecord) => Promise<LinkedSkills>
  /** The agent loaded fewer linked skills than its instructions said; this section replaces it. */
  reportLinkedSkills?: (sessionId: string, linkedSkills: string | null) => void
}

/** Resolve each input lazily once in agent-defined order; refusals before directory reads leave floating records unpinned. */
export type StructuredAgentLaunchBasis = {
  /** Exists, belongs to this agent, runs on this host, and pins what this agent drives. */
  record: AgentSessionRecord
  launchDirectory(): Promise<string>
  baseEnvironment(): Promise<Record<string, string>>
  /** The user's overlay for this agent; empty when none. */
  launchEnv(): Record<string, string>
  /** The base environment with the user's overlay laid over it. */
  environment(): Promise<Record<string, string>>
  /** Null when the chat gets no visuals. */
  visuals(): Promise<NativeChatVisualsLaunch | null>
  /** Null when there are none. A resumed conversation keeps the ones it started with, in both agents. */
  instructions(linkedSkills?: string | null): Promise<string | null>
  /** The MCP servers Orca adds (a bot's own and the host's list); none for a read-only session. */
  toolServers(): Promise<SessionMcpTools>
  /** The bot's linked-skills folder the chat loads beside the agent's own; none for any other chat. */
  linkedSkills(): Promise<LinkedSkills>
  /** After launch, when the agent turned the linked skill roots down. */
  linkedSkillsRefused(linkedSkills: string | null): void
  commandSettings(): StructuredAgentCommandSettings
  /** After a missing program, refresh both environment reads together; absent means no retry. */
  refreshAfterMissingProgram?: (askedAt: number) => Promise<void>
  /** The permission mode the host decided this start runs with; absent asks. */
  permissionMode?: AgentChatPermissionChoice
  /** The session may only read: the agent's part adds its own enforcement of this mode. */
  readOnly: ReadOnlySessionMode | null
}

export type StructuredLaunchRequest = {
  identity: AgentSessionJournalIdentity
  /** The reservation's token, which the seal hands the child. */
  spawnToken: string
  permissionMode?: AgentChatPermissionChoice
}

/** What the composition sets on a launch; an agent's part never does. */
type ComposedLaunchFields = 'cwd' | 'env' | 'envToDelete' | 'commandEnv'

export type StructuredAgentLaunchPart<L> = {
  launch: Omit<L, ComposedLaunchFields>
  /** The agent's environment, before the seal names the child. */
  env: Record<string, string>
  /** Agent-specific inherited keys to strip; composition adds the shared pane-identity keys. */
  inheritedEnvToDelete: readonly string[]
  /** See `sealStructuredSessionChild`. */
  cliRuntimeCommand?: string
  /** Added to the commands' environment (`SealedStructuredSessionChild.commandEnv`); the seal's identity wins. */
  commandEnv?: Readonly<Record<string, string>>
}

/** An agent's own part of a launch; it sees the session, never the spawn token. */
export type StructuredAgentLaunchPartResolver<L> = (
  basis: StructuredAgentLaunchBasis,
  identity: AgentSessionJournalIdentity
) => Promise<StructuredAgentLaunchPart<L>>

export type ComposedStructuredLaunch<L> = Omit<L, ComposedLaunchFields> & {
  cwd: string
  env: Record<string, string>
  envToDelete: string[]
  /** See `SealedStructuredSessionChild`; absent from a read, which seals no child. */
  commandEnv?: Record<string, string>
}

/** The child to spawn, sealed with the reservation's token. */
export type StructuredAgentLaunchResolver<L> = (
  request: StructuredLaunchRequest
) => Promise<ComposedStructuredLaunch<L>>

/** The same launch for a read that starts no child: the agent's own env, unsealed. */
export type StructuredAgentLaunchReader<L> = (
  identity: AgentSessionJournalIdentity
) => Promise<ComposedStructuredLaunch<L>>

function once<T>(read: () => T): () => T {
  let result: { value: T } | null = null
  return () => (result ??= { value: read() }).value
}

function admittedRecord(
  definition: StructuredAgentDefinition,
  store: StructuredAgentLaunchSources['store'],
  sessionId: string
): AgentSessionRecord {
  if (store.selectWritableRecord(sessionId).kind === 'missing') {
    throw new Error(`no durable agent-session record for ${sessionId}`)
  }
  const record = store.requireWritableRecord(sessionId)
  if (record.provider !== definition.agent) {
    throw new Error(`session ${sessionId} is a ${record.provider} session`)
  }
  const { location } = record
  // A session pinned elsewhere belongs to that host; local launch would create a second provider-session writer.
  if (!isNativeLocalLocation(location)) {
    throw new Error(
      `${definition.agent} structured sessions run on the local host, not ${location.executionHostId}`
    )
  }
  const agents = { definition: (agent: string) => (agent === definition.agent ? definition : null) }
  if (!agentDrivesSession(agents, record)) {
    // A transport migration (OMP's ACP-to-RPC cutover) leaves same-agent handles nothing can resume;
    // dropping those relics opens the session fresh instead of hard-erroring every migrated chat.
    const migrated = {
      ...record,
      providerHandleChain: record.providerHandleChain.filter(
        (link) =>
          link.handle.transport === definition.handleTransport ||
          link.handle.agent !== definition.agent
      )
    }
    if (
      migrated.providerHandleChain.length !== record.providerHandleChain.length &&
      agentDrivesSession(agents, migrated)
    ) {
      return migrated
    }
    const pin = definition.accountHomeVariable ?? definition.accountLocatorKind
    throw new Error(
      `session ${sessionId}'s account home or handles are not ${definition.agent}'s: its sessions pin ${pin} and hold ${definition.handleTransport} handles`
    )
  }
  return record
}

async function composedPart<L>(
  definition: StructuredAgentDefinition,
  sources: StructuredAgentLaunchSources,
  part: StructuredAgentLaunchPartResolver<L>,
  identity: AgentSessionJournalIdentity,
  permissionMode?: AgentChatPermissionChoice
): Promise<StructuredAgentLaunchPart<L> & { cwd: string }> {
  const record = admittedRecord(definition, sources.store, identity.sessionId)
  const launchEnv = once(() => sources.resolveAgentLaunchEnv?.(definition.agent) ?? {})
  const launchDirectory = once(() => resolveAgentSessionLaunchDirectory(sources, record))
  const readEnvironments = () => ({
    base: once(sources.resolveBaseEnvironment),
    agent: once(() => sources.resolveAgentEnvironment(definition.agent))
  })
  let environments = readEnvironments()
  const refresh = sources.refreshAfterMissingProgram
  const readOnly = sources.readOnlySession?.(record.sessionId) ?? null
  const basis: StructuredAgentLaunchBasis = {
    record,
    launchDirectory,
    baseEnvironment: () => environments.base(),
    launchEnv,
    environment: () => environments.agent(),
    // A read-only session gets no visuals folder, which is a place it could write.
    visuals: once(async () =>
      readOnly ? null : ((await sources.prepareVisuals?.(record.sessionId)) ?? null)
    ),
    // A launch asks once; the section is the first call's.
    instructions: (() => {
      let read: Promise<string | null> | null = null
      return (linkedSkills: string | null = null) =>
        (read ??= (async () =>
          sources.resolveInstructions
            ? sources.resolveInstructions(
                record,
                await launchDirectory(),
                linkedSkills,
                definition.instructionsEachStart
              )
            : linkedSkills)())
    })(),
    // A read-only session gets none: Look around keeps every tool off.
    toolServers: once(async () =>
      readOnly || !sources.resolveToolServers
        ? SessionMcpTools.none
        : sources.resolveToolServers(record, await launchDirectory())
    ),
    linkedSkills: once(
      async () => (await sources.resolveLinkedSkills?.(record)) ?? NO_LINKED_SKILLS
    ),
    linkedSkillsRefused: (linkedSkills) =>
      sources.reportLinkedSkills?.(record.sessionId, linkedSkills),
    commandSettings: once(() => sources.resolveCommandSettings?.() ?? {}),
    ...(refresh
      ? {
          refreshAfterMissingProgram: async (askedAt) => {
            await refresh(askedAt)
            environments = readEnvironments()
          }
        }
      : {}),
    // Ask, whatever the chat chose: the agent's part answers its asks from the read-only allow-list.
    ...(readOnly ? { permissionMode: 'ask' as const } : permissionMode ? { permissionMode } : {}),
    readOnly
  }
  await sources.prepareLaunch?.(record, await launchDirectory())
  const composed = await part(basis, identity)
  return {
    ...composed,
    // Why: applied once here so no agent can opt out of stripping the launching pane's identity.
    inheritedEnvToDelete: [...STRUCTURED_CHILD_ENV_TO_DELETE, ...composed.inheritedEnvToDelete],
    cwd: await basis.launchDirectory()
  }
}

export function composeStructuredLaunch<L>(
  definition: StructuredAgentDefinition,
  sources: StructuredAgentLaunchSources,
  part: StructuredAgentLaunchPartResolver<L>
): StructuredAgentLaunchResolver<L> {
  return async ({ identity, spawnToken, permissionMode }) => {
    const { launch, cwd, env, inheritedEnvToDelete, cliRuntimeCommand, commandEnv } =
      await composedPart(definition, sources, part, identity, permissionMode)
    admittedRecord(definition, sources.store, identity.sessionId)
    const child = sealStructuredSessionChild({
      sessionId: identity.sessionId,
      spawnToken,
      env,
      inheritedEnvToDelete,
      ...(cliRuntimeCommand ? { cliRuntimeCommand } : {})
    })
    return {
      ...launch,
      cwd,
      env: child.env,
      envToDelete: child.envToDelete,
      commandEnv: { ...commandEnv, ...child.commandEnv }
    }
  }
}

export function composeStructuredLaunchRead<L>(
  definition: StructuredAgentDefinition,
  sources: StructuredAgentLaunchSources,
  part: StructuredAgentLaunchPartResolver<L>
): StructuredAgentLaunchReader<L> {
  return async (identity) => {
    const { launch, cwd, env, inheritedEnvToDelete } = await composedPart(
      definition,
      sources,
      part,
      identity
    )
    admittedRecord(definition, sources.store, identity.sessionId)
    return { ...launch, cwd, env, envToDelete: [...inheritedEnvToDelete] }
  }
}

/** The shared launch inputs of the runtime an agent's adapter is built in. */
export function structuredAgentLaunchSources(
  context: Pick<StructuredAgentAdapterContext, 'deps' | 'store' | 'environment'>
): StructuredAgentLaunchSources {
  const { deps } = context
  return {
    store: context.store,
    resolveWorkspacePath: deps.resolveWorkspacePath,
    resolveBaseEnvironment: context.environment.resolveBaseEnvironment,
    resolveAgentEnvironment: context.environment.resolveAgentEnvironment,
    refreshAfterMissingProgram: context.environment.refreshAfterMissingProgram,
    ...(deps.resolveAgentLaunchEnv ? { resolveAgentLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
    ...(deps.resolveAgentCommandSettings
      ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
      : {}),
    ...(deps.resolveSessionInstructions
      ? { resolveInstructions: deps.resolveSessionInstructions }
      : {}),
    ...(deps.readOnlySession ? { readOnlySession: deps.readOnlySession } : {}),
    ...(deps.resolveSessionToolServers
      ? { resolveToolServers: deps.resolveSessionToolServers }
      : {}),
    ...(deps.prepareSessionLaunch ? { prepareLaunch: deps.prepareSessionLaunch } : {}),
    ...(deps.resolveSessionLinkedSkills
      ? { resolveLinkedSkills: deps.resolveSessionLinkedSkills }
      : {}),
    ...(deps.reportSessionLinkedSkills
      ? { reportLinkedSkills: deps.reportSessionLinkedSkills }
      : {}),
    // Wired by the real hosts only, so a test runtime never loads the bundled skill.
    ...(deps.nativeChatVisuals
      ? {
          prepareVisuals: createNativeChatVisualsDelivery({
            stateDirectory: deps.stateDirectory,
            logger: deps.logger,
            isEnabled: deps.nativeChatVisuals.isEnabled
          })
        }
      : {})
  }
}
