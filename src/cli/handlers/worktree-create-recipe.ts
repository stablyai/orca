import type { RuntimeStatus, RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import { WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY } from '../../shared/host-runtime-capabilities'
import {
  RECIPE_WORKSPACE_CREATE_FAILED_CODE,
  RECIPE_WORKSPACE_CREATE_PHASES,
  isRecipeWorkspaceCreatePhase
} from '../../shared/recipe-workspace-create-progress'
import { RuntimeClient, RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  type CliAgentLaunch
} from '../agent-launch-request'
import { formatWorktreeShow, printResult } from '../format'
import { printHookWarning } from './worktree-removal-warnings'
import { printLineageSummary } from './worktree-lineage-summary'

// Idle bound only: the host sends a keepalive every few seconds while the recipe runs, and the
// recipe's own timeoutSeconds (orca.yaml) bounds the whole create.
const RECIPE_CREATE_IDLE_TIMEOUT_MS = 600_000

type RecipeWorktreeCreateResult = RuntimeWorktreeCreateResult & {
  recipe: { id: string; runtimeId: string; environmentId: string; checkoutMode: string }
  environmentWarnings?: string[]
}

function formatRecipeCreated(value: RecipeWorktreeCreateResult): string {
  return [
    formatWorktreeShow(value),
    `recipe: ${value.recipe.id} (${value.recipe.checkoutMode})`,
    `environment: ${value.recipe.environmentId}`,
    ...(value.environmentWarnings ?? []).map((warning) => `warning: ${warning}`)
  ].join('\n')
}

/** Recipes run only where the Orca desktop app owns them; refuse before anything is created. */
export async function assertRecipeHost(client: RuntimeClient): Promise<void> {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run recipe commands on the computer whose Orca provisions the recipe, without --environment or --pairing-code.'
    )
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKTREE_RECIPE_CREATE_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca cannot create workspaces from recipes. Use the Orca desktop app on this computer, updated to the latest version.'
    )
  }
}

/** `orca worktree create --recipe`: the host that owns the recipe provisions, then adopts. */
export async function createWorktreeOnRecipe(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  recipeId: string
  launch?: CliAgentLaunch
  json: boolean
}): Promise<void> {
  const { client, create, recipeId, launch, json, flags } = args
  if (flags.get('activate') === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--activate is not supported with --recipe yet; open the new workspace from the Orca sidebar.'
    )
  }
  if (launch?.operationId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Retry the agent with `orca agent launch` on the recipe environment and existing workspace; --retry-launch would provision another machine.'
    )
  }
  await assertRecipeHost(client)
  if (!json) {
    console.error(
      `Creating "${String(create.name)}" on a new environment from recipe "${recipeId}". This can take several minutes; Ctrl+C stops it.`
    )
  }
  let created: RuntimeRpcSuccess<RecipeWorktreeCreateResult>
  try {
    created = await client.call<RecipeWorktreeCreateResult>(
      'worktree.create',
      {
        // --run-hooks implies activation, which a recipe workspace on another host cannot do yet.
        ...create,
        activate: false,
        navigation: undefined,
        recipeId,
        ...(launch ? { createdWithAgent: launch.agent } : {})
      },
      {
        timeoutMs: RECIPE_CREATE_IDLE_TIMEOUT_MS,
        onProgress: ({ phase }) => {
          if (!json && isRecipeWorkspaceCreatePhase(phase)) {
            console.error(`- ${RECIPE_WORKSPACE_CREATE_PHASES[phase]}...`)
          }
        }
      }
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === RECIPE_WORKSPACE_CREATE_FAILED_CODE) {
      throw new RuntimeClientError(error.code, error.message, {
        ...(typeof error.data === 'object' && error.data !== null ? error.data : {}),
        nextSteps: [
          `Validate the recipe with \`orca vm recipe doctor ${recipeId}\`.`,
          'Check Settings > Cloud VMs in Orca for an environment that still needs cleanup.'
        ]
      })
    }
    throw error
  }
  printHookWarning(created.result, json)
  if (!launch) {
    printLineageSummary(created.result, json)
    printResult(created, json, formatRecipeCreated)
    return
  }
  const environmentId = created.result.recipe.environmentId
  const worktree = `id:${created.result.worktree.id}`
  const remote = new RuntimeClient(
    client.userDataPath,
    RECIPE_CREATE_IDLE_TIMEOUT_MS,
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
        'Update Orca on the recipe-created environment to launch an agent.'
      )
    }
    const launched = await callAgentLaunch(
      remote,
      launch,
      {
        target: { kind: 'existing', worktree },
        presentation: 'background'
      },
      capabilities,
      recoveryArgs
    )
    const result = { ...created.result, launch: launched.result }
    printLineageSummary(result, json)
    printResult(
      { ...created, result },
      json,
      (value) => `${formatRecipeCreated(value)}\n${formatAgentLaunch(value.launch)}`
    )
  } catch (error) {
    // The workspace and its environment exist; say so instead of implying nothing happened.
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
