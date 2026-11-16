import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import type {
  RuntimeRpcProgress,
  RuntimeRpcSuccess
} from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { AgentLaunchResult } from '../../shared/agent-launch/contracts/agent-launch-intent'
import {
  ORCA_VM_RECIPE_ID_PATTERN,
  ORCA_VM_RECIPE_ID_RULE
} from '../../shared/workspace-setup/orca-vm-recipe-id'
import {
  RECIPE_WORKSPACE_CREATE_FAILED_CODE,
  RECIPE_WORKSPACE_CREATE_PHASES,
  WORKTREE_CREATE_ON_RECIPE_METHOD,
  isRecipeWorkspaceCreatePhase,
  type RecipeWorkspaceCreateResult
} from '../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-create-contract'
import {
  formatEnvironmentDoctorChecks,
  isEnvironmentDoctorCheck
} from '../../shared/workspace-setup/environment-doctor/environment-doctor-types'
import {
  getOptionalStringFlag,
  getPresentStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import {
  callAgentLaunch,
  formatAgentLaunch,
  getAgentLaunchCapabilities,
  readCliAgentLaunch,
  type CliAgentLaunch
} from '../agents/agent-launch-request'
import { printResult } from '../output/command-result-output'
import { resolveWorktreeCreateCwdContext } from '../workspace-selection/workspace-selector'
import { formatWorktreeShow } from './workspace-format'
import { getOptionalStartupAgent } from './worktree-create-startup-agent'
import { getOptionalSetupDecision } from './worktree-setup-decision-recovery'
import {
  assertWorkspaceTargetFlagsCompatible,
  getCreateRepoTarget,
  hasWorkspaceProjectTarget,
  type CliRepoTarget
} from './worktree-project-target'

// Idle bound only: the desktop sends a keepalive every few seconds while the recipe runs, and the
// recipe's own timeoutSeconds bound each of its steps.
const RECIPE_CREATE_IDLE_TIMEOUT_MS = 120_000
const AGENT_LAUNCH_TIMEOUT_MS = 600_000

const LINK_LATER =
  'link it afterwards with `orca worktree set --environment <environment-id> --worktree <selector>`'
// Each would need the new host to know this computer's context; refused before anything starts.
const UNSUPPORTED_WITH_RECIPE: Readonly<Record<string, string>> = {
  'project-host-setup': 'pass the source project with --repo or --project instead',
  'parent-worktree': 'the new workspace lives on its own host, so Orca records no parent for it',
  'parent-environment': 'the new workspace lives on its own host, so Orca records no parent for it',
  activate: 'open the new workspace from the Orca sidebar',
  'run-hooks': 'pass --setup run to run the setup script',
  'retry-launch':
    'a retry would provision another environment; retry the agent with `orca agent launch --environment <environment-id> --worktree <selector>`',
  reference: 'recipe workspaces do not take references yet',
  'reference-site': 'recipe workspaces do not take references yet',
  issue: LINK_LATER,
  pr: LINK_LATER,
  'linear-issue': LINK_LATER,
  'gitlab-issue': LINK_LATER,
  'gitlab-mr': LINK_LATER
}

type RecipeWorkspaceCliResult = RecipeWorkspaceCreateResult & { launch?: AgentLaunchResult }

/** `--on recipe:<id>`: the recipe id, validated before any request. */
function getRecipeOnTarget(flags: Map<string, string | boolean>): string {
  const value = flags.get('on')
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing value for --on. Pass recipe:<recipe-id>.'
    )
  }
  const target = value.trim()
  if (!target.startsWith('recipe:')) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --on target: ${target}. --on takes recipe:<recipe-id>, an environment recipe from the repo's orca.yaml. For a host that already exists, use --host.`
    )
  }
  const recipeId = target.slice('recipe:'.length)
  if (!ORCA_VM_RECIPE_ID_PATTERN.test(recipeId)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid recipe id in --on ${target}. ${ORCA_VM_RECIPE_ID_RULE}`
    )
  }
  return recipeId
}

function assertRecipeCreateFlagsSupported(flags: Map<string, string | boolean>): void {
  for (const [flag, hint] of Object.entries(UNSUPPORTED_WITH_RECIPE)) {
    if (flags.has(flag)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--${flag} is not supported with --on recipe:<id> yet: ${hint}.`
      )
    }
  }
  const host = getPresentStringFlag(flags, 'host')
  if (host !== undefined && host !== 'local') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--on recipe:<id> creates the host for the workspace; --host may only name local, where the source project and its orca.yaml are.'
    )
  }
}

async function resolveRecipeSourceRepo(context: HandlerContext): Promise<CliRepoTarget> {
  const { flags, client, cwd } = context
  if (flags.has('repo') || hasWorkspaceProjectTarget(flags)) {
    return await getCreateRepoTarget(flags, undefined, client)
  }
  // Like a plain create, the current Orca worktree names the repo when no flag does.
  let repoId: string | undefined
  try {
    repoId = (await resolveWorktreeCreateCwdContext(cwd, client, true, false)).repoId
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'selector_ambiguous') {
      throw error
    }
  }
  return repoId ? { repo: `id:${repoId}` } : await getCreateRepoTarget(flags, undefined, client)
}

/** Recipe output and named steps go to stderr, so --json keeps stdout to the result. */
function createProgressPrinter(): (progress: RuntimeRpcProgress) => void {
  let atLineStart = true
  return (progress) => {
    if (progress.output) {
      let text = ''
      for (const part of progress.output.split(/(?<=\n)/)) {
        text += `${atLineStart ? '  ' : ''}${part}`
        atLineStart = part.endsWith('\n')
      }
      process.stderr.write(text)
    }
    if (progress.phase && isRecipeWorkspaceCreatePhase(progress.phase)) {
      process.stderr.write(
        `${atLineStart ? '' : '\n'}- ${RECIPE_WORKSPACE_CREATE_PHASES[progress.phase]}...\n`
      )
      atLineStart = true
    }
  }
}

function recipeCreateFailure(error: unknown, recipeId: string): unknown {
  if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
    return new RuntimeClientError(
      'incompatible_runtime',
      'This Orca app cannot create workspaces from recipes yet. Update the Orca desktop app on this computer.'
    )
  }
  if (
    !(error instanceof RuntimeClientError) ||
    error.code !== RECIPE_WORKSPACE_CREATE_FAILED_CODE
  ) {
    return error
  }
  const data: Record<string, unknown> =
    typeof error.data === 'object' && error.data !== null ? { ...error.data } : {}
  const checks = Array.isArray(data.environmentChecks)
    ? data.environmentChecks.filter(isEnvironmentDoctorCheck)
    : []
  if (checks.length > 0) {
    console.error('Failed environment checks:')
    for (const line of formatEnvironmentDoctorChecks(checks)) {
      console.error(`  ${line}`)
    }
  }
  return new RuntimeClientError(error.code, error.message, {
    ...data,
    nextSteps: [
      `Validate the recipe end to end with \`orca vm recipe doctor ${recipeId} --provision --json\`.`,
      ...(data.environment === 'destroy-failed' || data.environment === 'left-running'
        ? [
            'Remove the environment in Orca under Settings > Experimental > Cloud VM, or with your provider.'
          ]
        : [])
    ]
  })
}

function formatRecipeWorkspace(value: RecipeWorkspaceCliResult): string {
  return [
    formatWorktreeShow({ worktree: value.worktree }),
    `host: ${value.host.id} (new, from recipe:${value.host.recipeId}, ${value.host.checkoutMode})`,
    `vm: ${value.host.runtimeId}`,
    ...(value.launch ? [formatAgentLaunch(value.launch)] : [])
  ].join('\n')
}

async function launchAgentOnRecipeWorkspace(
  client: RuntimeClient,
  created: RecipeWorkspaceCreateResult,
  launch: CliAgentLaunch,
  flags: Map<string, string | boolean>
): Promise<AgentLaunchResult> {
  const { environmentId } = created.host
  const worktree = `id:${created.worktree.id}`
  // A lost reply is retried against the new host and this workspace, never by provisioning again.
  const retryArgs = ['agent', 'launch', '--environment', environmentId, '--worktree', worktree]
  for (const name of ['agent', 'model', 'effort', 'surface', 'prompt']) {
    const value = flags.get(name)
    if (typeof value === 'string') {
      retryArgs.push(`--${name}`, value)
    }
  }
  const host = new RuntimeClient(client.userDataPath, AGENT_LAUNCH_TIMEOUT_MS, null, environmentId)
  try {
    const capabilities = await getAgentLaunchCapabilities(host)
    if (!capabilities) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update Orca on the recipe-created environment to launch an agent there.'
      )
    }
    const launched = await callAgentLaunch(
      host,
      launch,
      { target: { kind: 'existing', worktree }, presentation: 'background' },
      capabilities,
      retryArgs
    )
    return launched.result
  } catch (error) {
    // The workspace and its environment exist; say so instead of implying nothing happened.
    if (!(error instanceof RuntimeClientError)) {
      throw error
    }
    const data = typeof error.data === 'object' && error.data !== null ? error.data : {}
    throw new RuntimeClientError(error.code, `${error.message} The workspace was created.`, {
      ...data,
      worktree: created.worktree.id,
      host: created.host,
      nextSteps: [
        ...('nextSteps' in data && Array.isArray(data.nextSteps) ? data.nextSteps : []),
        `Launch the agent on it with \`orca agent launch --environment ${environmentId} --worktree ${worktree} --agent ${launch.agent}\`.`
      ]
    })
  }
}

/**
 * `orca worktree create --on recipe:<id>`: the Orca desktop app on this computer provisions the
 * recipe from the repo's orca.yaml, sets the project up on the host it created, creates the
 * workspace there and attaches it to the VM, exactly as the new-workspace dialog's
 * Run on > Per-Workspace Environment does. With --agent, the agent then starts on that host.
 */
export async function createWorktreeOnRecipe(context: HandlerContext): Promise<void> {
  const { flags, client, json } = context
  const recipeId = getRecipeOnTarget(flags)
  assertRecipeCreateFlagsSupported(flags)
  assertWorkspaceTargetFlagsCompatible(flags)
  const startupAgent = getOptionalStartupAgent(flags)
  // Read before any request, so a bad prompt, model or effort starts no machine.
  const launch = startupAgent
    ? readCliAgentLaunch(flags, startupAgent, { createsWorktree: false })
    : undefined
  const setupDecision = getOptionalSetupDecision(flags)
  const name = getRequiredStringFlag(flags, 'name')
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Recipe workspaces are created by the Orca desktop app on this computer, which owns the recipe and its VMs. Drop --environment and --pairing-code, and unset ORCA_ENVIRONMENT and ORCA_PAIRING_CODE.'
    )
  }
  const repoTarget = await resolveRecipeSourceRepo(context)
  const params = {
    recipeId,
    ...repoTarget,
    name,
    displayName: name,
    displayNameKind: 'user',
    baseBranch: getOptionalStringFlag(flags, 'base-branch'),
    branchNameOverride: getPresentStringFlag(flags, 'branch'),
    comment: getOptionalStringFlag(flags, 'comment'),
    ...(setupDecision ? { setupDecision } : {}),
    ...(launch ? { createdWithAgent: launch.agent } : {})
  }
  console.error(
    `Creating "${name}" on a new environment from recipe:${recipeId}. This can take several minutes; Ctrl+C stops it and the Orca app destroys what it started.`
  )
  // Closing the socket aborts the request; the desktop then destroys a started environment.
  const onInterrupt = (): void => {
    console.error('\nStopping. The Orca app destroys the new environment in the background.')
    process.exit(130)
  }
  process.once('SIGINT', onInterrupt)
  let created: RuntimeRpcSuccess<RecipeWorkspaceCreateResult>
  try {
    created = await client.call<RecipeWorkspaceCreateResult>(
      WORKTREE_CREATE_ON_RECIPE_METHOD,
      params,
      { timeoutMs: RECIPE_CREATE_IDLE_TIMEOUT_MS, onProgress: createProgressPrinter() }
    )
  } catch (error) {
    throw recipeCreateFailure(error, recipeId)
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
  if (!json) {
    for (const warning of created.result.warnings ?? []) {
      console.error(`warning: ${warning}`)
    }
  }
  const result: RecipeWorkspaceCliResult = launch
    ? {
        ...created.result,
        launch: await launchAgentOnRecipeWorkspace(client, created.result, launch, flags)
      }
    : created.result
  printResult({ ...created, result }, json, formatRecipeWorkspace)
}
