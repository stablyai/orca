// CLI worktree-create agent launch: parse --agent/--prompt into the one host-
// atomic `agentLaunch` request and consume the typed result union. The CLI is
// FAIL-FAST — it never assembles a command and never falls back to a base agent.
// A pre-create rejection or a post-create failure prints a stable machine code
// plus a client-safe human line to stderr and exits non-zero; a post-create
// failure still prints the retained worktree on stdout first (stable output).

import type { AgentLaunchSpawnRequest } from '../../shared/agent-launch-spawn-request'
import type {
  AgentLaunchFailure,
  AgentLaunchFailureCode,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import type {
  CreatedRuntimeWorktreeCreateResult,
  RuntimeStatus,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-types'
import type { BuiltInTuiAgent, WorktreeAgentLaunchRejection } from '../../shared/types'
import { AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { isBuiltInTuiAgent, isTuiAgent } from '../../shared/tui-agent-config'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'
import { formatWorktreeShow, printResult } from '../format'

type Flags = Map<string, string | boolean>

/** How the agent identity was chosen, named in the fail-fast stderr line. */
export type AgentLaunchSource = { via: 'flag'; id: string } | { via: 'default' }

export type WorktreeCreateAgentLaunch = {
  request: AgentLaunchSpawnRequest
  source: AgentLaunchSource
}

function getPromptText(flags: Flags): string | undefined {
  if (!flags.has('prompt')) {
    return undefined
  }
  // An explicit --prompt may be empty, but a valueless --prompt is an error.
  const value = flags.get('prompt')
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --prompt')
  }
  return value
}

function buildRequest(
  selection: AgentLaunchSpawnRequest['selection'],
  prompt: string | undefined
): AgentLaunchSpawnRequest {
  return {
    selection,
    // The CLI always launches the requested agent, prompt or not.
    allowEmptyPromptLaunch: true,
    ...(prompt !== undefined ? { prompt } : {})
  }
}

/** Build the host-atomic agentLaunch request from --agent/--prompt. A bare
 *  --agent (no value) selects the stored default; --agent <id> names an agent.
 *  The host resolves identity and fails fast — the CLI sends no command/env. */
export function getWorktreeCreateAgentLaunch(flags: Flags): WorktreeCreateAgentLaunch | undefined {
  if (!flags.has('agent')) {
    if (flags.has('prompt')) {
      throw new RuntimeClientError('invalid_argument', '--prompt requires --agent')
    }
    return undefined
  }
  const prompt = getPromptText(flags)
  const value = flags.get('agent')
  if (value === true) {
    return { request: buildRequest({ kind: 'default' }, prompt), source: { via: 'default' } }
  }
  if (typeof value === 'string' && value.length > 0) {
    if (!isTuiAgent(value)) {
      throw new RuntimeClientError('invalid_argument', `Unknown TUI agent "${value}"`)
    }
    return {
      request: buildRequest({ kind: 'agent', agent: value }, prompt),
      source: { via: 'flag', id: value }
    }
  }
  throw new RuntimeClientError('invalid_argument', 'Missing value for --agent')
}

/** The launch's worktree.create wire shape: the host-atomic request, or the
 *  legacy host-resolved id fields for a pre-identity host. */
export type WorktreeCreateLaunchParams =
  | { agentLaunch: AgentLaunchSpawnRequest }
  | { startupAgent: BuiltInTuiAgent; startupPrompt: string }

type LaunchCapabilityClient = Pick<RuntimeClient, 'call' | 'isRemote'>

async function hostSupportsAgentLaunchIdentity(client: LaunchCapabilityClient): Promise<boolean> {
  try {
    const status = await client.call<RuntimeStatus>('status.get')
    return status.result.capabilities?.includes(AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY) === true
  } catch {
    // Mobile parity: an unreachable probe reads as unsupported, degrading to
    // the legacy id path every host still accepts.
    return false
  }
}

/** Negotiate the launch wire shape. A remote pairing may reach a pre-identity
 *  `orca serve` host whose schema silently strips the unknown `agentLaunch` key
 *  (agent-less worktree), so probe agent-launch.identity.v1 and fall back to the
 *  legacy host-resolved startupAgent id. Local runtimes ship with this CLI. */
export async function resolveWorktreeCreateLaunchParams(
  client: LaunchCapabilityClient,
  launch: WorktreeCreateAgentLaunch
): Promise<WorktreeCreateLaunchParams> {
  if (!client.isRemote || (await hostSupportsAgentLaunchIdentity(client))) {
    return { agentLaunch: launch.request }
  }
  const selection = launch.request.selection
  // FAIL-FAST: a pre-identity host cannot resolve a stored default or a custom id.
  if (selection.kind !== 'agent') {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host predates default-agent launch. Pass --agent <id> or update the host.'
    )
  }
  if (!isBuiltInTuiAgent(selection.agent)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host predates custom agents. Pass a built-in --agent id or update the host.'
    )
  }
  return { startupAgent: selection.agent, startupPrompt: launch.request.prompt ?? '' }
}

// Client-safe reasons: never reference argv, env keys/values, paths, or labels.
const FAILURE_REASONS: Record<AgentLaunchFailureCode, string> = {
  unknown_agent: 'the agent no longer exists',
  no_agent_selected: 'no agent is selected — set a default or pass --agent <id>',
  agent_definition_needs_repair: 'the agent is not fully configured (finish it in Settings)',
  custom_agent_disabled: 'the agent is turned off (enable it in Settings)',
  agent_configuration_changed: 'the agent configuration changed (review it in Settings)',
  base_agent_disabled: 'the underlying agent is turned off (enable it in Settings)',
  base_agent_unavailable: 'the underlying agent is not available on this host',
  missing_variable: 'the workspace path could not be resolved for this launch',
  missing_target_home: 'the home directory on the target host could not be resolved',
  invalid_command_override: 'the command override is invalid (fix it in Settings)',
  invalid_agent_args: 'the launch arguments are invalid (fix them in Settings)',
  invalid_agent_env: 'the launch environment is invalid (fix it in Settings)',
  secure_env_transport_unavailable: 'the environment cannot be sent securely to the remote host',
  launch_command_too_long: 'the launch command is too long to run',
  invalid_launch_snapshot: 'the saved launch details are no longer valid',
  trust_preflight_failed: 'workspace trust could not be confirmed',
  spawn_failed: 'the agent could not be started',
  launch_state_unknown: 'the launch status is unknown',
  launch_capacity_exceeded: 'too many agent launches are in progress'
}

const REQUEST_ERROR_REASONS: Record<AgentLaunchRequestError['code'], string> = {
  idempotency_conflict: 'this launch is already in progress',
  stale_agent_launch_failure: 'this launch was already resolved',
  untrusted_reference: 'the launch source could not be verified'
}

// A newer host may send a code this CLI predates — never print "undefined".
function reasonForCode(reasons: Record<string, string | undefined>, code: string): string {
  return reasons[code] ?? 'the launch failed for a reason this CLI version does not recognize'
}

function describeSource(source: AgentLaunchSource, requestedAgent: string | undefined): string {
  if (source.via === 'flag') {
    return `agent "${source.id}" requested via --agent`
  }
  return requestedAgent
    ? `the stored default agent "${requestedAgent}"`
    : 'the stored default agent'
}

function failureHumanLine(failure: AgentLaunchFailure, source: AgentLaunchSource): string {
  return `Could not launch ${describeSource(source, failure.requestedAgent)}: ${reasonForCode(FAILURE_REASONS, failure.code)}.`
}

function rejectionParts(
  rejection: WorktreeAgentLaunchRejection,
  source: AgentLaunchSource
): { code: string; human: string } {
  if (rejection.status === 'failed') {
    return { code: rejection.failure.code, human: failureHumanLine(rejection.failure, source) }
  }
  const requested = source.via === 'flag' ? source.id : 'the stored default agent'
  return {
    code: rejection.requestError.code,
    human: `Could not launch ${
      source.via === 'flag' ? `agent "${requested}"` : requested
    }: ${reasonForCode(REQUEST_ERROR_REASONS, rejection.requestError.code)}.`
  }
}

function printAgentLaunchStderr(code: string, human: string): void {
  // Plan contract: stable machine-readable code on line 1, human line on line 2.
  console.error(code)
  console.error(human)
}

/** Handle a pre-create rejection (`created: false`). Prints the typed rejection
 *  (JSON envelope) or the stderr contract (human), sets a non-zero exit, and
 *  returns null. Otherwise returns the created arm for normal printing. */
export function handleWorktreeCreatePreRejection(
  response: RuntimeRpcSuccess<RuntimeWorktreeCreateResult>,
  source: AgentLaunchSource | undefined,
  json: boolean
): CreatedRuntimeWorktreeCreateResult | null {
  const result = response.result
  if (result.created !== false) {
    return result
  }
  if (json) {
    printResult(response, true, () => '')
  } else if (source) {
    const { code, human } = rejectionParts(result.agentLaunchResult, source)
    printAgentLaunchStderr(code, human)
  }
  process.exitCode = 1
  return null
}

/** Print the created worktree (stable output on stdout) and, when the post-create
 *  launch failed, emit the fail-fast stderr contract and set a non-zero exit. The
 *  workspace is retained either way. */
export function printWorktreeCreateResult(
  response: RuntimeRpcSuccess<RuntimeWorktreeCreateResult>,
  created: CreatedRuntimeWorktreeCreateResult,
  source: AgentLaunchSource | undefined,
  json: boolean
): void {
  const createdResponse: RuntimeRpcSuccess<CreatedRuntimeWorktreeCreateResult> = {
    ...response,
    result: created
  }
  printResult(createdResponse, json, formatWorktreeShow)
  if (created.agentLaunchResult?.status !== 'failed') {
    return
  }
  // JSON already carries the failure in the printed envelope; only the human
  // surface needs the stderr contract. Either way the exit is non-zero.
  if (!json && source) {
    printAgentLaunchStderr(
      created.agentLaunchResult.failure.code,
      failureHumanLine(created.agentLaunchResult.failure, source)
    )
  }
  process.exitCode = 1
}
