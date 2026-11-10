import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { AGENT_UPDATE_CATALOG } from '../../shared/agent-updates/agent-update-catalog'
import { parseAgentVersion } from '../../shared/agent-updates/agent-version'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { hasPathSeparatorToken } from '../../shared/managed-agent-command-token'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import { readInstalledVersion, resolveAgentBinary } from './agent-binary'
import type { AgentUpdateSettings } from './check-agent-updates'
import { planAgentUpdate } from './update-plan'

export type AgentUpdateRunOutcome =
  | { status: 'done'; version: string }
  | { status: 'failed'; message: string }
  | { status: 'manual'; command: string }

const UPDATE_TIMEOUT_MS = 300_000
const MESSAGE_MAX_CHARS = 500

const inFlight = new Map<TuiAgent, Promise<AgentUpdateRunOutcome>>()

function failed(message: string): AgentUpdateRunOutcome {
  return { status: 'failed', message }
}

function outputTail(result: ProcessResult): string {
  const lines = stripAnsiEscapeSequences([result.stdout, result.stderr].join('\n')).split(/\r?\n/)
  return lines
    .filter((line) => line.trim())
    .join('\n')
    .trim()
    .slice(-MESSAGE_MAX_CHARS)
}

// Why: Windows cannot spawn bare `npm` (it is npm.cmd), so a bare program runs by its PATH location.
async function resolveProgram(program: string): Promise<string | null> {
  if (hasPathSeparatorToken(program)) {
    return program
  }
  return resolveCommandOnLocalPath(program, { env: buildLocalPreflightEnv() ?? process.env })
}

function logFailure(agent: TuiAgent, detail: unknown): void {
  try {
    console.warn(`[agent-updates] ${agent}: update failed`, detail)
  } catch {
    // Logging must never turn a reported failure into a thrown one.
  }
}

function describeFailure(result: ProcessResult): string | null {
  if (result.timedOut) {
    return 'The update timed out after 5 minutes.'
  }
  if (result.code === 0 && !result.signal) {
    return null
  }
  const tail = outputTail(result)
  if (tail) {
    return tail
  }
  return result.signal
    ? `The update command was stopped by ${result.signal}.`
    : `The update command exited with code ${result.code}.`
}

async function performUpdate(
  agent: TuiAgent,
  previousVersion: string,
  settings: AgentUpdateSettings
): Promise<AgentUpdateRunOutcome> {
  const info = AGENT_UPDATE_CATALOG[agent]
  if (info === 'unsupported' || 'followsAgent' in info) {
    return failed(`${agent} cannot be updated from Orca.`)
  }
  const resolved = await resolveAgentBinary(agent, settings.agentCmdOverrides)
  if (!resolved) {
    return failed(`${agent} is not installed.`)
  }
  const plan = planAgentUpdate(info, resolved, process.platform)
  if (!plan) {
    return failed(`${agent} has no update step Orca can run for this install.`)
  }
  if (plan.kind === 'manual') {
    return { status: 'manual', command: plan.command }
  }
  const program = await resolveProgram(plan.program)
  if (!program) {
    return failed(`Could not find ${plan.program} to run the update.`)
  }
  const result = await runProcess(
    {
      program,
      args: plan.args,
      env: buildLocalPreflightEnv() ?? process.env,
      timeoutMs: UPDATE_TIMEOUT_MS,
      terminationBarrier: true
    },
    'tail'
  )
  const failure = describeFailure(result)
  if (failure) {
    logFailure(agent, {
      program,
      args: plan.args,
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr
    })
    return failed(failure)
  }
  const output = await readInstalledVersion(resolved.binary, info.versionArgs ?? ['--version'])
  const version = output && parseAgentVersion(output)
  if (!version) {
    return failed('The update finished but the installed version could not be verified.')
  }
  if (version === previousVersion) {
    return failed(`The update command finished but the installed version is still ${version}.`)
  }
  return { status: 'done', version }
}

async function guardedUpdate(
  agent: TuiAgent,
  previousVersion: string,
  settings: AgentUpdateSettings
): Promise<AgentUpdateRunOutcome> {
  try {
    return await performUpdate(agent, previousVersion, settings)
  } catch (error) {
    logFailure(agent, error)
    return failed(error instanceof Error ? error.message : String(error))
  }
}

/** Runs the agent's update step; a second call while one is running shares its outcome. */
export function runAgentUpdate(
  agent: TuiAgent,
  previousVersion: string,
  settings: AgentUpdateSettings
): Promise<AgentUpdateRunOutcome> {
  const running = inFlight.get(agent)
  if (running) {
    return running
  }
  const started = guardedUpdate(agent, previousVersion, settings).finally(() => {
    inFlight.delete(agent)
  })
  inFlight.set(agent, started)
  return started
}
