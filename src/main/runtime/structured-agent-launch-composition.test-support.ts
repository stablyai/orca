// Each agent's composed launch resolver over test doubles, built the way its registration builds
// it, so resolver tests exercise the shared launch path rather than a copy of it.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
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
import {
  composeStructuredLaunch,
  type StructuredAgentLaunchResolver,
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
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

function launchSources(deps: LaunchTestSources): StructuredAgentLaunchSources {
  const resolveEnvironment = deps.resolveEnvironment
  return {
    store: deps.store,
    resolveWorkspacePath: deps.resolveWorkspacePath ?? (async (id) => `/repos/${id}`),
    resolveBaseEnvironment: async () => definedEnv((await resolveEnvironment?.()) ?? {}),
    ...(deps.resolveLaunchEnv ? { resolveAgentLaunchEnv: deps.resolveLaunchEnv } : {}),
    ...(deps.resolveCommandSettings ? { resolveCommandSettings: deps.resolveCommandSettings } : {}),
    ...(deps.prepareVisuals ? { prepareVisuals: deps.prepareVisuals } : {})
  }
}

/** Called as an adapter calls it: with a spawn token, unless the test asks for an unsealed read. */
function withTestSpawnToken<L>(
  resolve: StructuredAgentLaunchResolver<L>,
  defaultToken: string | null
) {
  return (input: { identity: AgentSessionJournalIdentity; spawnToken?: string | null }) =>
    resolve({
      identity: input.identity,
      spawnToken: input.spawnToken === undefined ? defaultToken : input.spawnToken
    })
}

/** Unsealed unless a token is passed: the env an agent part produced, before the seal. */
export function createCodexStructuredLaunchResolver(
  deps: LaunchTestSources & CodexStructuredLaunchPartDeps
) {
  return withTestSpawnToken(
    composeStructuredLaunch(
      CODEX_STRUCTURED_AGENT,
      launchSources(deps),
      codexStructuredLaunchPart(deps)
    ),
    null
  )
}

/** Unsealed unless a token is passed: the env an agent part produced, before the seal. */
export function createAcpStructuredLaunchResolver(
  spec: AcpLaunchSpec,
  deps: LaunchTestSources & AcpStructuredLaunchPartDeps
) {
  return withTestSpawnToken(
    composeStructuredLaunch(
      acpStructuredAgentDefinition(spec),
      launchSources(deps),
      acpStructuredLaunchPart(spec, deps)
    ),
    null
  )
}

/** Unsealed unless a token is passed: the env an agent part produced, before the seal. */
export function createPiRpcLaunchResolver(deps: LaunchTestSources & PiRpcLaunchPartDeps) {
  const resolve = composeStructuredLaunch(PI_RPC_AGENT, launchSources(deps), piRpcLaunchPart(deps))
  return (identity: AgentSessionJournalIdentity, spawnToken: string | null = null) =>
    resolve({ identity, spawnToken })
}

/** Sealed with `TEST_SPAWN_TOKEN` unless the test passes another: Claude's launch env has always
 *  carried the session's identity. `resolveEnv` is Claude's overlay; `resolveInheritedEnv`, its
 *  base, defaults to this process's env as a launch without one inherits it. */
export function createClaudeStructuredLaunchResolver(
  deps: Omit<LaunchTestSources, 'resolveEnvironment' | 'resolveLaunchEnv'> &
    Pick<ClaudeEnvDeps, 'resolveInheritedEnv'> & {
      resolveEnv?: () => Record<string, string> | undefined
    } & ClaudeStructuredLaunchPartDeps
) {
  const { resolveEnv, resolveInheritedEnv } = deps
  return withTestSpawnToken(
    composeStructuredLaunch(
      CLAUDE_STRUCTURED_AGENT,
      launchSources({
        ...deps,
        resolveEnvironment: resolveInheritedEnv ?? (async () => process.env),
        ...(resolveEnv ? { resolveLaunchEnv: () => resolveEnv() ?? {} } : {})
      }),
      claudeStructuredLaunchPart(deps)
    ),
    TEST_SPAWN_TOKEN
  )
}
