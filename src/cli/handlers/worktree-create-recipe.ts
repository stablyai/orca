import type { RuntimeStatus, RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import { WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY } from '../../shared/worktree-recipe-create-capability'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  type CliAgentLaunch
} from '../agent-launch-request'
import { formatWorktreeShow, printResult } from '../format'
import { printHookWarning } from './worktree-removal-warnings'
import { printLineageSummary } from './worktree-lineage-summary'

export async function createWorktreeOnRecipe(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  recipeId: string
  launch?: CliAgentLaunch
  json: boolean
}): Promise<void> {
  const { client, create, recipeId, launch, json, flags } = args
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run --recipe on the provisioning host, without --environment or --pairing-code.'
    )
  }
  if (launch?.operationId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Retry the agent with agent launch on the recipe environment and existing workspace; do not provision another machine.'
    )
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the provisioning host to create a workspace with --recipe.'
    )
  }
  const created = await client.call<RuntimeWorktreeCreateResult & { recipeEnvironmentId: string }>(
    'worktree.create',
    {
      ...create,
      recipeId,
      ...(launch ? { createdWithAgent: launch.agent } : {})
    },
    { timeoutMs: 600_000 }
  )
  printHookWarning(created.result, json)
  if (!launch) {
    printLineageSummary(created.result, json)
    printResult(
      created,
      json,
      (value) => `${formatWorktreeShow(value)}\nenvironment: ${value.recipeEnvironmentId}`
    )
    return
  }
  const environmentId = created.result.recipeEnvironmentId
  const worktree = `id:${created.result.worktree.id}`
  const remote = new RuntimeClient(undefined, 600_000, null, `id:${environmentId}`)
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
  for (const name of ['model', 'effort']) {
    const value = flags.get(name)
    if (typeof value === 'string') {
      recoveryArgs.push(`--${name}`, value)
    }
  }
  if (launch.prompt) {
    recoveryArgs.push('--prompt', launch.prompt.text)
  }
  if (create.activate === true) {
    recoveryArgs.push('--activate')
  }
  try {
    const capabilities = await getAgentLaunchCapabilities(remote)
    if (!capabilities) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on the recipe-created host to launch an agent.'
      )
    }
    const launched = await callAgentLaunch(
      remote,
      launch,
      {
        target: { kind: 'existing', worktree },
        presentation: create.activate === true ? 'focused' : 'background'
      },
      capabilities,
      recoveryArgs
    )
    const result = { ...created.result, launch: launched.result }
    printLineageSummary(result, json)
    printResult(
      { ...created, result },
      json,
      (value) =>
        `${formatWorktreeShow(value)}\nenvironment: ${environmentId}\n${formatAgentLaunch(value.launch)}`
    )
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, {
        ...(typeof error.data === 'object' && error.data !== null ? error.data : {}),
        recipeEnvironmentId: environmentId,
        worktreeId: created.result.worktree.id
      })
    }
    throw error
  }
}
