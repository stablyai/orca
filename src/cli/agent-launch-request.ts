// agent.launch shares desktop/mobile policy; absent --surface uses the host's Chat UI setting.

import { randomUUID } from 'node:crypto'
import type { AgentLaunchPrompt, AgentLaunchResult } from '../shared/agent-launch-intent'
import { AGENT_LAUNCH_SURFACES, type AgentLaunchSurface } from '../shared/agent-launch-surface'
import { checkAgentLaunchModelPreferences } from '../shared/agent-launch-model-preferences'
import {
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
  PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
} from '../shared/agent-launch-runtime-capability'
import { createStructuredAgentSessionOperationId } from '../shared/structured-agent-session-mutation'
import { parseAgentSessionOperationTimestamp } from '../shared/agent-session-host-authority'
import type { RuntimeStatus } from '../shared/runtime-types'
import type { TuiAgent } from '../shared/tui-agent'
import { isTuiAgent } from '../shared/tui-agent-config'
import {
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty,
  rejectValuelessFlag
} from './flags'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from './runtime-client'
import { withCliAgentLaunchRecovery } from './agent-launch-recovery'

type Flags = Map<string, string | boolean>

/** The host strips agent fields from the worktree.create payload. */
export type CliAgentLaunchTarget =
  | { kind: 'existing'; worktree: string }
  | { kind: 'create-worktree'; create: Record<string, unknown> }

export type CliAgentLaunch = {
  agent: TuiAgent
  prompt?: AgentLaunchPrompt
  sessionOptions?: Record<string, string>
  operationId?: string
  surface?: AgentLaunchSurface
}

export type ResolvedCliDefaultAgent = {
  agent: TuiAgent
  source: 'project' | 'global' | 'automatic'
  projectId?: string
  projectName?: string
}

export async function resolveCliDefaultAgent(
  client: RuntimeClient,
  target: { repo: string; repoHostId?: string } | { worktree: string },
  capabilities: readonly string[] | null
): Promise<ResolvedCliDefaultAgent> {
  if (!capabilities?.includes(PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca execution host cannot resolve project default agents. Update Orca on that host, or pass an explicit --agent.'
    )
  }
  let result: RuntimeRpcSuccess<{
    agent: TuiAgent | null
    source: ResolvedCliDefaultAgent['source']
    projectId?: string
    projectName?: string
  }>
  try {
    result = await client.call('agent.resolveDefault', target)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca execution host cannot resolve project default agents. Update Orca on that host, or pass an explicit --agent.'
      )
    }
    throw error
  }
  const resolved = result.result
  if (resolved.agent === null) {
    const name = resolved.projectName ?? resolved.projectId ?? 'the target workspace'
    const recovery =
      'repo' in target ? 'create the workspace without --agent' : 'update the project default agent'
    throw new RuntimeClientError(
      'invalid_argument',
      resolved.source === 'automatic'
        ? `No enabled agent is available on the execution host for ${name}. Install an agent, choose an explicit --agent, or ${recovery}.`
        : `The effective default for ${name} is Blank Terminal. Choose an explicit --agent or ${recovery}.`
    )
  }
  return { ...resolved, agent: resolved.agent }
}

export function frozenDefaultRecoveryArgs(
  rawArgs: readonly string[] | undefined,
  agent: TuiAgent
): readonly string[] | undefined {
  if (!rawArgs) {
    return undefined
  }
  const args = [...rawArgs]
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--agent' && args[index + 1] === 'default') {
      args[index + 1] = agent
      break
    }
    if (args[index] === '--agent=default') {
      args[index] = `--agent=${agent}`
      break
    }
  }
  return args
}

export function rejectDefaultLaunchRetry(flags: Flags): void {
  if (flags.has('retry-launch')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Retry a default launch with the resolved agent from the previous recoveryCommand. --agent default could select a different agent after project settings change.'
    )
  }
}

function readSurfaceFlag(flags: Flags): AgentLaunchSurface | undefined {
  if (!flags.has('surface')) {
    return undefined
  }
  const surface = getRequiredStringFlag(flags, 'surface')
  const known = AGENT_LAUNCH_SURFACES.find((candidate) => candidate === surface)
  if (!known) {
    throw new RuntimeClientError('invalid_argument', '--surface must be one of: chat, terminal')
  }
  return known
}

export function parseCliAgent(value: string): TuiAgent {
  if (!isTuiAgent(value)) {
    throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${value}"`)
  }
  return value
}

export function readCliAgentLaunch(
  flags: Flags,
  agent: TuiAgent,
  target: { createsWorktree: boolean }
): CliAgentLaunch {
  const checked = checkAgentLaunchModelPreferences({
    agent,
    model: getOptionalStringFlag(flags, 'model'),
    effort: getOptionalStringFlag(flags, 'effort'),
    createsWorktree: target.createsWorktree,
    // The execution host verifies an OpenCode model itself before it starts one.
    openCodeModelLaunchSupported: true
  })
  if ('refusal' in checked) {
    throw new RuntimeClientError(checked.refusal.code, checked.refusal.message)
  }
  const prompt = flags.get('prompt')
  rejectValuelessFlag(prompt, 'prompt')
  const operationId = flags.has('retry-launch')
    ? getRequiredStringFlagAllowingEmpty(flags, 'retry-launch')
    : undefined
  if (operationId !== undefined && parseAgentSessionOperationTimestamp(operationId) === null) {
    throw new RuntimeClientError('invalid_argument', 'Malformed --retry-launch operation ID')
  }
  const surface = readSurfaceFlag(flags)
  return {
    agent,
    ...(surface ? { surface } : {}),
    ...(operationId ? { operationId } : {}),
    ...(typeof prompt === 'string' && prompt.trim()
      ? { prompt: { text: prompt, delivery: 'submit' as const } }
      : {}),
    ...(checked.preferences ? { sessionOptions: { ...checked.preferences } } : {})
  }
}

export function hasLaunchModelFlags(flags: Flags): boolean {
  return flags.has('model') || flags.has('effort')
}

// An older host strips `surface` and follows its own setting, so an explicit pick never reaches it.
export const SURFACE_UNSUPPORTED_MESSAGE =
  'This Orca host cannot start an agent as a chat or a terminal on request. Update Orca on the execution host, or omit --surface.'

export async function getAgentLaunchCapabilities(
  client: RuntimeClient
): Promise<readonly string[] | null> {
  const status = await client.call<RuntimeStatus>('status.get')
  const capabilities = status.result.capabilities ?? []
  return capabilities.includes(AGENT_LAUNCH_RUNTIME_CAPABILITY) ? capabilities : null
}

export async function callAgentLaunch(
  client: RuntimeClient,
  launch: CliAgentLaunch,
  request: { target: CliAgentLaunchTarget; presentation?: 'focused' | 'background' },
  capabilities: readonly string[],
  rawArgs?: readonly string[]
): Promise<RuntimeRpcSuccess<AgentLaunchResult & { operationId?: string }>> {
  const replaySupported = capabilities.includes(AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY)
  if (launch.operationId && !replaySupported) {
    throw new RuntimeClientError(
      'agent_session_operation_unknown',
      'This host cannot replay the earlier launch. Return to the original execution host; do not retry without --retry-launch.'
    )
  }
  if (launch.prompt && !capabilities.includes(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot safely carry launch prompts. Update Orca on the execution host.'
    )
  }
  if (launch.surface && !capabilities.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError('incompatible_runtime', SURFACE_UNSUPPORTED_MESSAGE)
  }
  if (!capabilities.includes(AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot honor CLI launch focus or background behavior. Update Orca on the execution host.'
    )
  }
  const operationId = replaySupported
    ? (launch.operationId ?? createStructuredAgentSessionOperationId(randomUUID))
    : undefined
  const params = {
    ...request,
    ...launch,
    ...(operationId ? { operationId } : {}),
    launchSource: 'cli'
  }
  const result = await withCliAgentLaunchRecovery(
    client.call<AgentLaunchResult>(operationId ? 'agent.launchReplay' : 'agent.launch', params),
    { operationId, replayed: launch.operationId !== undefined, rawArgs, params }
  )
  return { ...result, result: { ...result.result, ...(operationId ? { operationId } : {}) } }
}

export function formatAgentLaunch(
  result: AgentLaunchResult & {
    operationId?: string
    resolvedAgent?: ResolvedCliDefaultAgent
  }
): string {
  const { outcome, receipt } = result
  return [
    `agent: ${outcome.kind === 'structured' ? 'chat session' : 'terminal'}`,
    `handle: ${outcome.handle}`,
    ...(outcome.kind === 'structured' ? [`sessionId: ${outcome.sessionId}`] : []),
    `worktreeId: ${result.worktreeId}`,
    ...(result.resolvedAgent
      ? [
          `resolvedAgent: ${result.resolvedAgent.agent}`,
          `selectionSource: ${result.resolvedAgent.source}`,
          ...(result.resolvedAgent.projectName || result.resolvedAgent.projectId
            ? [
                `targetProject: ${result.resolvedAgent.projectName ?? result.resolvedAgent.projectId}`
              ]
            : [])
        ]
      : []),
    ...(result.operationId ? [`operationId: ${result.operationId}`] : []),
    `why: ${receipt.detail}`,
    ...(result.prompt ? [`prompt: ${result.prompt.outcome}`] : []),
    ...(result.warning ? [`warning: ${result.warning}`] : [])
  ].join('\n')
}
