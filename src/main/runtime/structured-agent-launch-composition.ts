// The one launch path every native-chat agent's resolver runs through. The shared steps live here:
// admitting the record, its launch directory, the base environment and the user's overlay, the
// chat's visuals, and sealing the child. An agent's own part never sets the directory or the
// sealed environment; it only adds what is that agent's.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import { agentDrivesSession } from '../native-chat/agent-session-wire/structured-agent-session-provider-support'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import {
  createNativeChatVisualsDelivery,
  type NativeChatVisualsLaunch,
  type PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
import { resolveAgentSessionLaunchDirectory } from './agent-session-launch-directory'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { StructuredAgentAdapterContext } from './structured-agent-runtime-registrations'
import { sealStructuredSessionChild } from './structured-session-child-env'

/** Where a launch's shared inputs come from. */
export type StructuredAgentLaunchSources = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'pinLaunchDirectory'>
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveBaseEnvironment: () => Promise<Record<string, string>>
  /** The base environment with the user's overlay for `agent` laid over it. */
  resolveAgentEnvironment: (agent: string) => Promise<Record<string, string>>
  /** The user's per-agent environment overlay from settings. */
  resolveAgentLaunchEnv?: (agent: string) => Record<string, string>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  prepareVisuals?: PrepareNativeChatVisuals
}

/** What an agent's part reads. Each read runs once, when the part first asks, so every agent keeps
 *  its own order: a refusal it states before reading the directory still leaves a floating record
 *  unpinned. */
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
  commandSettings(): StructuredAgentCommandSettings
}

export type StructuredLaunchRequest = {
  identity: AgentSessionJournalIdentity
  /** The reservation's token, which the seal hands the child. */
  spawnToken: string
}

export type StructuredAgentLaunchPart<L> = {
  launch: Omit<L, 'cwd' | 'env' | 'envToDelete'>
  /** The agent's environment, before the seal names the child. */
  env: Record<string, string>
  /** Inherited keys this agent's child must not keep; required, so an agent states even none. */
  inheritedEnvToDelete: readonly string[]
  /** See `sealStructuredSessionChild`. */
  cliRuntimeCommand?: string
}

/** An agent's own part of a launch; it sees the session, never the spawn token. */
export type StructuredAgentLaunchPartResolver<L> = (
  basis: StructuredAgentLaunchBasis,
  identity: AgentSessionJournalIdentity
) => Promise<StructuredAgentLaunchPart<L>>

export type ComposedStructuredLaunch<L> = Omit<L, 'cwd' | 'env' | 'envToDelete'> & {
  cwd: string
  env: Record<string, string>
  envToDelete: string[]
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
  const record = store.getRecord(sessionId)
  if (!record) {
    throw new Error(`no durable agent-session record for ${sessionId}`)
  }
  if (record.provider !== definition.agent) {
    throw new Error(`session ${sessionId} is a ${record.provider} session`)
  }
  const { location } = record
  // A session pinned elsewhere belongs to that host's runtime; starting it here would put a second
  // writer on the same provider session.
  if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
    throw new Error(
      `${definition.agent} structured sessions run on the local host, not ${location.executionHostId}`
    )
  }
  const agents = { definition: (agent: string) => (agent === definition.agent ? definition : null) }
  if (!agentDrivesSession(agents, record)) {
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
  identity: AgentSessionJournalIdentity
): Promise<StructuredAgentLaunchPart<L> & { cwd: string }> {
  const record = admittedRecord(definition, sources.store, identity.sessionId)
  const launchEnv = once(() => sources.resolveAgentLaunchEnv?.(definition.agent) ?? {})
  const basis: StructuredAgentLaunchBasis = {
    record,
    launchDirectory: once(() => resolveAgentSessionLaunchDirectory(sources, record)),
    baseEnvironment: once(sources.resolveBaseEnvironment),
    launchEnv,
    environment: once(() => sources.resolveAgentEnvironment(definition.agent)),
    visuals: once(async () => (await sources.prepareVisuals?.(record.sessionId)) ?? null),
    commandSettings: once(() => sources.resolveCommandSettings?.() ?? {})
  }
  const composed = await part(basis, identity)
  return { ...composed, cwd: await basis.launchDirectory() }
}

export function composeStructuredLaunch<L>(
  definition: StructuredAgentDefinition,
  sources: StructuredAgentLaunchSources,
  part: StructuredAgentLaunchPartResolver<L>
): StructuredAgentLaunchResolver<L> {
  return async ({ identity, spawnToken }) => {
    const { launch, cwd, env, inheritedEnvToDelete, cliRuntimeCommand } = await composedPart(
      definition,
      sources,
      part,
      identity
    )
    const child = sealStructuredSessionChild({
      sessionId: identity.sessionId,
      spawnToken,
      env,
      inheritedEnvToDelete,
      ...(cliRuntimeCommand ? { cliRuntimeCommand } : {})
    })
    return { ...launch, cwd, env: child.env, envToDelete: child.envToDelete }
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
    ...(deps.resolveAgentLaunchEnv ? { resolveAgentLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
    ...(deps.resolveAgentCommandSettings
      ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
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
