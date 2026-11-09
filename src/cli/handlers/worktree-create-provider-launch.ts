import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import { parseExecutionHostId } from '../../shared/execution-host'
import { RuntimeClient, RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  type CliAgentLaunch
} from '../agent-launch-request'
import { printResult } from '../format'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { printLineageSummary } from './worktree-lineage-summary'

/** The exit-4 code: the workspace exists, a step after it (agent launch) failed. */
export const WORKSPACE_FOLLOW_UP_FAILED_CODE = 'workspace_follow_up_failed' as const

const LAUNCH_IDLE_TIMEOUT_MS = 600_000

export type ProviderWorktreeCreateResult = RuntimeWorktreeCreateResult & {
  host: {
    id: string
    origin: { target: string; runtimeId: string }
    lifecycle: 'per-workspace'
    state: string
    checkoutMode: string
  }
  hostWarnings?: string[]
}

/** Starts the agent on the new host; a failure exits 4 with the created workspace in data.result. */
export async function launchOnNewHost(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  launch: CliAgentLaunch
  json: boolean
  created: RuntimeRpcSuccess<ProviderWorktreeCreateResult & { idempotencyKey: string }>
  format: (value: ProviderWorktreeCreateResult) => string
}): Promise<void> {
  const { client, flags, launch, json, created, format } = args
  const parsedHost = parseExecutionHostId(created.result.host.id)
  const environmentId =
    parsedHost?.kind === 'runtime' ? parsedHost.environmentId : created.result.host.id
  const worktree = `id:${created.result.worktree.id}`
  const remote = new RuntimeClient(
    client.userDataPath,
    LAUNCH_IDLE_TIMEOUT_MS,
    null,
    `id:${environmentId}`
  )
  const recoveryArgs = [
    'agent',
    'launch',
    '--agent',
    launch.agent,
    '--worktree',
    worktree,
    '--environment',
    `id:${environmentId}`
  ]
  for (const name of ['model', 'effort', 'surface']) {
    const value = flags.get(name)
    if (typeof value === 'string') {
      recoveryArgs.push(`--${name}`, value)
    }
  }
  if (launch.prompt) {
    recoveryArgs.push('--prompt', launch.prompt.text)
  }
  try {
    const capabilities = await getAgentLaunchCapabilities(remote)
    if (!capabilities) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on the new host to launch an agent.'
      )
    }
    const launched = await callAgentLaunch(
      remote,
      launch,
      { target: { kind: 'existing', worktree }, presentation: 'background' },
      capabilities,
      recoveryArgs
    )
    const result = { ...created.result, launch: launched.result }
    printLineageSummary(result, json)
    printResult(
      { ...created, result },
      json,
      (value) => `${format(value)}\n${formatAgentLaunch(value.launch)}`
    )
  } catch (error) {
    // The workspace and its host exist: print the create result and exit 4, so a script never
    // reruns the create (which would make a second machine).
    const cause =
      error instanceof RuntimeClientError
        ? { code: error.code, message: error.message, data: error.data }
        : { code: 'runtime_error', message: error instanceof Error ? error.message : String(error) }
    // A lost launch reply carries a replay-safe --retry-launch command; prefer it over a fresh launch.
    const innerSteps =
      typeof cause.data === 'object' &&
      cause.data !== null &&
      'nextSteps' in cause.data &&
      Array.isArray(cause.data.nextSteps)
        ? cause.data.nextSteps.filter((step): step is string => typeof step === 'string')
        : []
    throw new RuntimeClientError(
      WORKSPACE_FOLLOW_UP_FAILED_CODE,
      `Created the workspace on ${created.result.host.id}, but launching the agent failed: ${cause.message}`,
      {
        result: created.result,
        followUp: { step: 'agent-launch', error: cause },
        nextSteps:
          innerSteps.length > 0
            ? innerSteps
            : [`orca ${recoveryArgs.map(quoteCliCommandArgument).join(' ')}`]
      }
    )
  }
}
