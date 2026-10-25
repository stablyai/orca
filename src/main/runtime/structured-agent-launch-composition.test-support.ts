// Build agent launch resolvers with production composition over test doubles so tests exercise the shared path.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../acp/acp-structured-agent-definitions'
import {
  acpStructuredLaunchPart,
  type AcpStructuredLaunchPartDeps
} from '../acp/acp-structured-launch-resolution'
import { CLAUDE_STRUCTURED_AGENT } from '../claude/claude-structured-agent-definition'
import type { ClaudeEnvDeps } from '../claude/claude-structured-child-env'
import {
  claudeStructuredLaunchPart,
  type ClaudeStructuredLaunchPartDeps
} from '../claude/claude-structured-launch-resolution'
import { CODEX_STRUCTURED_AGENT } from '../codex/codex-structured-agent-definition'
import {
  codexStructuredLaunchPart,
  type CodexStructuredLaunchPartDeps
} from '../codex/codex-structured-launch-resolution'
import type { PrepareNativeChatVisuals } from '../native-chat/native-chat-visuals-delivery'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import { PI_RPC_AGENT } from '../pi/rpc-agent-definition'
import { piRpcLaunchPart, type PiRpcLaunchPartDeps } from '../pi/rpc-launch-resolution'
import type { StructuredAgentDefinition } from '../native-chat/agent-session-wire/structured-agent-definition'
import {
  composeStructuredLaunch,
  composeStructuredLaunchRead,
  type StructuredAgentLaunchPartResolver,
  type StructuredAgentLaunchSources
} from './structured-agent-launch-composition'

export const TEST_SPAWN_TOKEN = 'test-spawn-token'

export type LaunchTestSources = Pick<StructuredAgentLaunchSources, 'store'> & {
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  /** The base env; none is an empty one. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveLaunchEnv?: (agent: string) => Record<string, string>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  prepareVisuals?: PrepareNativeChatVisuals
  refreshAfterMissingProgram?: (askedAt: number) => Promise<void>
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function launchSources(deps: LaunchTestSources): StructuredAgentLaunchSources {
  const resolveEnvironment = deps.resolveEnvironment
  const resolveBaseEnvironment = async () => definedEnv((await resolveEnvironment?.()) ?? {})
  return {
    store: deps.store,
    resolveWorkspacePath: deps.resolveWorkspacePath ?? (async (id) => `/repos/${id}`),
    resolveBaseEnvironment,
    resolveAgentEnvironment: async (agent) => ({
      ...(await resolveBaseEnvironment()),
      ...deps.resolveLaunchEnv?.(agent)
    }),
    ...(deps.resolveLaunchEnv ? { resolveAgentLaunchEnv: deps.resolveLaunchEnv } : {}),
    ...(deps.resolveCommandSettings ? { resolveCommandSettings: deps.resolveCommandSettings } : {}),
    ...(deps.prepareVisuals ? { prepareVisuals: deps.prepareVisuals } : {}),
    ...(deps.refreshAfterMissingProgram
      ? { refreshAfterMissingProgram: deps.refreshAfterMissingProgram }
      : {})
  }
}

/** Sealed with a spawn token, as an adapter's start calls it; with none, the unsealed read. */
function withTestSpawnToken<L>(
  definition: StructuredAgentDefinition,
  sources: StructuredAgentLaunchSources,
  part: StructuredAgentLaunchPartResolver<L>,
  defaultToken: string | null
) {
  const resolve = composeStructuredLaunch(definition, sources, part)
  const read = composeStructuredLaunchRead(definition, sources, part)
  return (input: {
    identity: AgentSessionJournalIdentity
    spawnToken?: string | null
    permissionMode?: AgentChatPermissionMode
  }) => {
    const spawnToken = input.spawnToken === undefined ? defaultToken : input.spawnToken
    return spawnToken === null
      ? read(input.identity)
      : resolve({
          identity: input.identity,
          spawnToken,
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {})
        })
  }
}

/** Unsealed unless a token is passed: the env an agent part produced, before the seal. */
export function createCodexStructuredLaunchResolver(
  deps: LaunchTestSources & CodexStructuredLaunchPartDeps
) {
  return withTestSpawnToken(
    CODEX_STRUCTURED_AGENT,
    launchSources(deps),
    codexStructuredLaunchPart(deps),
    null
  )
}

/** Unsealed unless a token is passed: the env an agent part produced, before the seal. */
export function createAcpStructuredLaunchResolver(
  spec: AcpLaunchSpec,
  deps: LaunchTestSources &
    Omit<AcpStructuredLaunchPartDeps, 'dataDirectory'> &
    Partial<Pick<AcpStructuredLaunchPartDeps, 'dataDirectory'>>
) {
  return withTestSpawnToken(
    acpStructuredAgentDefinition(spec),
    launchSources(deps),
    acpStructuredLaunchPart(spec, { dataDirectory: '/orca-data', ...deps }),
    null
  )
}

/** Unsealed unless a token is passed: the env an agent part produced, before the seal. */
export function createPiRpcLaunchResolver(deps: LaunchTestSources & PiRpcLaunchPartDeps) {
  const resolve = withTestSpawnToken(PI_RPC_AGENT, launchSources(deps), piRpcLaunchPart(deps), null)
  return (identity: AgentSessionJournalIdentity, spawnToken: string | null = null) =>
    resolve({ identity, spawnToken })
}

/** Seal Claude with TEST_SPAWN_TOKEN unless overridden; resolveEnv overlays resolveInheritedEnv, which defaults to process.env. */
export function createClaudeStructuredLaunchResolver(
  deps: Omit<LaunchTestSources, 'resolveEnvironment' | 'resolveLaunchEnv'> &
    Pick<ClaudeEnvDeps, 'resolveInheritedEnv'> & {
      resolveEnv?: () => Record<string, string> | undefined
    } & ClaudeStructuredLaunchPartDeps
) {
  const { resolveEnv, resolveInheritedEnv } = deps
  return withTestSpawnToken(
    CLAUDE_STRUCTURED_AGENT,
    launchSources({
      ...deps,
      resolveEnvironment: resolveInheritedEnv ?? (async () => process.env),
      ...(resolveEnv ? { resolveLaunchEnv: () => resolveEnv() ?? {} } : {})
    }),
    claudeStructuredLaunchPart(deps),
    TEST_SPAWN_TOKEN
  )
}
