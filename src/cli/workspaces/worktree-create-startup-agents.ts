// --agent starts one agent with the new worktree; --agents a,b runs one task on several, one worktree each.

import type { AgentLaunchResult } from '../../shared/agent-launch/contracts/agent-launch-intent'
import {
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
} from '../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  callAgentLaunch,
  getAgentLaunchCapabilities,
  parseCliAgent,
  readCliAgentLaunch
} from '../agents/agent-launch-request'
import { getPresentStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { folderSetupUnsupportedWarning } from './folder-setup-support-warning'
import { withSetupDecisionRecovery } from './worktree-setup-decision-recovery'

type Flags = Map<string, string | boolean>

const MAX_ATTEMPTS = 6
// Per-agent or single-checkout options; each attempt needs its own name, branch and launch.
const FANOUT_INCOMPATIBLE_FLAGS = [
  'agent',
  'model',
  'effort',
  'surface',
  'retry-launch',
  'branch',
  'activate',
  'run-hooks'
]

export type WorktreeAttempt = {
  agent: TuiAgent
  name: string
  worktreeId: string
  launch: AgentLaunchResult & { operationId?: string }
}

export function getOptionalStartupAgent(flags: Flags): TuiAgent | undefined {
  const agent = getPresentStringFlag(flags, 'agent')
  if (agent === undefined) {
    const needsAgent = ['prompt', 'model', 'effort', 'surface', 'retry-launch'].find((name) =>
      flags.has(name)
    )
    if (needsAgent) {
      throw new RuntimeClientError('invalid_argument', `--${needsAgent} requires --agent`)
    }
    return undefined
  }
  return parseCliAgent(agent)
}

export function readFanoutAgents(flags: Flags): TuiAgent[] | undefined {
  if (!flags.has('agents')) {
    return undefined
  }
  const conflict = FANOUT_INCOMPATIBLE_FLAGS.find((name) => flags.has(name))
  if (conflict) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--agents cannot be combined with --${conflict}`
    )
  }
  const agents = getRequiredStringFlag(flags, 'agents')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseCliAgent)
  if (agents.length < 2 || agents.length > MAX_ATTEMPTS) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--agents takes 2 to ${MAX_ATTEMPTS} comma-separated agents, such as claude,codex`
    )
  }
  const prompt = flags.get('prompt')
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new RuntimeClientError('invalid_argument', '--agents requires --prompt with the task')
  }
  return agents
}

/** `fix-claude`, `fix-codex`; an agent listed twice gets `fix-claude-1`, `fix-claude-2`. */
export function fanoutAttemptNames(name: string, agents: readonly TuiAgent[]): string[] {
  const seen = new Map<TuiAgent, number>()
  return agents.map((agent) => {
    const repeated = agents.filter((candidate) => candidate === agent).length > 1
    const index = (seen.get(agent) ?? 0) + 1
    seen.set(agent, index)
    return repeated ? `${name}-${agent}-${index}` : `${name}-${agent}`
  })
}

// A lost reply's recovery command must replay that one attempt, not the whole fan-out.
function singleAttemptArgs(rawArgs: readonly string[], agent: TuiAgent, name: string): string[] {
  const args: string[] = []
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--agents' || arg === '--name') {
      index++
    } else if (!arg.startsWith('--agents=') && !arg.startsWith('--name=')) {
      args.push(arg)
      continue
    }
    args.push(...(arg.startsWith('--agents') ? ['--agent', agent] : ['--name', name]))
  }
  return args
}

function withStartedAttempts(error: unknown, attempts: WorktreeAttempt[], failed: string): unknown {
  if (attempts.length === 0 || !(error instanceof RuntimeClientError)) {
    return error
  }
  const started = attempts.map((attempt) => attempt.name).join(', ')
  return new RuntimeClientError(
    error.code,
    `${error.message} (attempt ${failed}; already started: ${started}; later attempts were not started)`,
    {
      ...(typeof error.data === 'object' && error.data !== null ? error.data : {}),
      startedAttempts: attempts.map(({ agent, name, worktreeId, launch }) => ({
        agent,
        name,
        worktreeId,
        handle: launch.outcome.handle
      }))
    }
  )
}

function quoteArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value)
}

function formatAttempts(value: { attempts: WorktreeAttempt[] }): string {
  const rows = value.attempts.map(
    ({ agent, name, worktreeId, launch }) =>
      `${name}  agent: ${agent}  handle: ${launch.outcome.handle}\n  worktreeId: ${worktreeId}`
  )
  const compare = value.attempts.map(
    ({ worktreeId }) => `--worktree ${quoteArg(`id:${worktreeId}`)}`
  )
  return [
    ...rows,
    `When they finish: orca worktree compare ${compare.join(' ')} --agent ${value.attempts[0]?.agent}`
  ].join('\n')
}

export async function createWorktreeAttempts(args: {
  client: RuntimeClient
  flags: Flags
  create: Record<string, unknown>
  name: string
  agents: readonly TuiAgent[]
  json: boolean
  rawArgs?: readonly string[]
}): Promise<void> {
  const { client, flags, create, name: baseName, agents, json, rawArgs } = args
  const capabilities = await getAgentLaunchCapabilities(client)
  if (
    !capabilities?.includes(AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY) ||
    !capabilities.includes(AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot start several agents from one command. Update Orca on the execution host, or create each worktree with --agent.'
    )
  }
  const names = fanoutAttemptNames(baseName, agents)
  const attempts: WorktreeAttempt[] = []
  let envelope: RuntimeRpcSuccess<unknown> | undefined
  for (const [index, agent] of agents.entries()) {
    const name = names[index]
    try {
      const launched = await withSetupDecisionRecovery(
        callAgentLaunch(
          client,
          readCliAgentLaunch(flags, agent, { createsWorktree: true }),
          {
            target: { kind: 'create-worktree', create: { ...create, name, displayName: name } },
            presentation: 'background'
          },
          capabilities,
          rawArgs && singleAttemptArgs(rawArgs, agent, name)
        )
      )
      envelope ??= launched
      attempts.push({
        agent,
        name,
        worktreeId: launched.result.worktreeId,
        launch: launched.result
      })
    } catch (error) {
      throw withStartedAttempts(error, attempts, name)
    }
  }
  const setupWarning = await folderSetupUnsupportedWarning(client, attempts[0]?.worktreeId, create)
  if (setupWarning) {
    console.error(`warning: ${setupWarning}`)
  }
  if (envelope) {
    printResult({ ...envelope, result: { attempts } }, json, formatAttempts)
  }
}
