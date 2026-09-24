import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  cleanupEphemeralVmRuntime,
  provisionEphemeralVmRuntime
} from '../main/ephemeral-vm-runtime-service'
import {
  redactEphemeralVmRecipeDiagnosticText,
  redactEphemeralVmRecipeResultForDiagnostics
} from '../shared/ephemeral-vm-recipe-diagnostics'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { parseOrcaYaml } from '../shared/orca-yaml'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import { redactRuntimeEnvironment } from '../shared/runtime-environments'
import type { RuntimeRepoList } from '../shared/runtime-types'
import type { CommandHandler } from './dispatch'
import { printResult } from './format'
import { getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { getDefaultUserDataPath, RuntimeClientError } from './runtime-client'
import type { RuntimeRpcSuccess } from './runtime-client'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment,
  resolveEnvironment
} from './runtime/environments'

export const createRecipeEnvironment: CommandHandler = async ({ client, flags, cwd, json }) => {
  const recipeId = getRequiredStringFlag(flags, 'recipe')
  const repoPath = resolve(getOptionalStringFlag(flags, 'repo-path') ?? cwd)
  const recipe = loadRecipe(repoPath, recipeId)
  if (recipe.checkoutMode === 'provisioned-root') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Provisioned-root recipes are not supported by `orca environment create` yet. Create this environment from the Orca desktop.'
    )
  }
  const repos = await client.call<RuntimeRepoList>('repo.list')
  const repo = repos.result.repos.find((entry) => resolve(entry.path) === repoPath)
  if (!repo) {
    throw new RuntimeClientError(
      'invalid_argument',
      `The repository at ${repoPath} is not registered in Orca. Run \`orca repo add --path ${repoPath}\` first.`
    )
  }
  if (repo.connectionId || (repo.executionHostId && repo.executionHostId !== 'local')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Environment recipes must be created from a repository registered on this local Orca host.'
    )
  }

  const userDataPath = getDefaultUserDataPath()
  const provisioned = await provisionEphemeralVmRuntime({
    userDataPath,
    repoPath,
    repoId: repo.id,
    recipe,
    ...(repo.gitRemoteIdentity?.remoteUrl ? { repoUrl: repo.gitRemoteIdentity.remoteUrl } : {})
  })
  if (!provisioned.ok) {
    throw new RuntimeClientError(
      'runtime_error',
      formatRecipeFailure(
        provisioned.start.error,
        provisioned.start.stderr,
        provisioned.start.stdout
      )
    )
  }

  const connection = getEphemeralVmRecipeResultConnection(provisioned.start.result)
  if (connection.type !== 'orca-server') {
    const cleanup = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: provisioned.runtime.id
    })
    const suffix = automaticCleanupFailureSuffix({
      cleanup,
      recipeId: recipe.id,
      runtimeId: provisioned.runtime.id,
      pairingRetained: false
    })
    throw new RuntimeClientError(
      'invalid_argument',
      `SSH recipes are not supported by \`orca environment create\` yet; use the Orca desktop.${suffix}`
    )
  }

  let environment: ReturnType<typeof addEnvironmentFromPairingCode> | undefined
  try {
    environment = addEnvironmentFromPairingCode(userDataPath, {
      name:
        getOptionalStringFlag(flags, 'name') ??
        `${basename(repoPath)} ${recipe.name} ${provisioned.runtime.id.slice(-8)}`,
      pairingCode: connection.pairingCode,
      source: 'ephemeral-vm'
    })
    const runtime = updateEphemeralVmRuntimeStatus(userDataPath, provisioned.runtime.id, {
      runtimeEnvironmentId: environment.id
    })
    const result = {
      environment: redactRuntimeEnvironment(environment),
      providerState: projectProviderState(runtime)
    }
    printResult(localSuccess(result), json, ({ environment: value }) =>
      [
        `Created environment ${value.name} (${value.id}).`,
        `Use it with --environment ${value.name}.`,
        `Destroy it with: orca environment destroy --environment ${value.name}`
      ].join('\n')
    )
  } catch (error) {
    const cleanup = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: provisioned.runtime.id
    }).catch((cleanupError) => ({
      ok: false as const,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    }))
    if (cleanup.ok && !cleanup.skipped && environment) {
      try {
        removeEnvironment(userDataPath, environment.id)
      } catch {
        // Provider cleanup already succeeded. A stale local pairing can be removed separately.
      }
    }
    const message = redactEphemeralVmRecipeDiagnosticText(
      error instanceof Error ? error.message : String(error)
    )
    const suffix = automaticCleanupFailureSuffix({
      cleanup,
      recipeId: recipe.id,
      runtimeId: provisioned.runtime.id,
      pairingRetained: environment !== undefined
    })
    throw new RuntimeClientError('runtime_error', `${message}${suffix}`)
  }
}

export const removeEnvironmentWithProviderCleanup: CommandHandler = async ({
  client,
  flags,
  json
}) => {
  const selector = getRequiredStringFlag(flags, 'environment')
  const userDataPath = getDefaultUserDataPath()
  const environment = resolveEnvironment(userDataPath, selector)
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (entry) => entry.runtimeEnvironmentId === environment.id
  )
  const force = flags.get('force') === true
  if (!runtime && environment.source === 'ephemeral-vm' && !force) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Environment ${environment.name} is marked recipe-managed, but its lifecycle record is missing. Orca cannot prove provider cleanup. After manual cleanup, use \`orca environment rm --environment ${environment.name} --force\`.`
    )
  }
  let cleanedRuntime: EphemeralVmRuntimeRecord | undefined
  if (runtime && !force) {
    const repos = await client.call<RuntimeRepoList>('repo.list')
    const repo = runtime.repoId
      ? repos.result.repos.find((entry) => entry.id === runtime.repoId)
      : undefined
    if (!repo) {
      throw new RuntimeClientError(
        'runtime_error',
        `The repository for environment ${environment.name} is no longer registered in Orca; re-add it before retrying cleanup.`
      )
    }
    const recipe = runtime.recipe ?? loadRecipe(repo.path, runtime.recipeId)
    const cleanup = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: repo.path,
      recipe,
      runtimeId: runtime.id
    })
    if (!cleanup.ok) {
      throw new RuntimeClientError(
        'runtime_error',
        `Provider cleanup failed for ${environment.name}: ${redactEphemeralVmRecipeDiagnosticText(cleanup.error)}. The pairing was retained; retry this command after fixing the provider error.`
      )
    }
    if (cleanup.skipped) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Destroy is disabled or missing for ${environment.name}, so Orca cannot prove provider cleanup. The pairing was retained. After manual provider cleanup, use \`orca environment rm --environment ${environment.name} --force\`.`
      )
    }
    cleanedRuntime = cleanup.runtime
  }
  const removed = redactRuntimeEnvironment(removeEnvironment(userDataPath, environment.id))
  const forcedManaged = force && (runtime !== undefined || environment.source === 'ephemeral-vm')
  const result = {
    removed,
    providerCleanup: cleanedRuntime
      ? 'succeeded'
      : forcedManaged
        ? 'forced-skipped'
        : 'not-managed',
    providerState: projectProviderState(cleanedRuntime ?? runtime)
  }
  printResult(localSuccess(result), json, () =>
    cleanedRuntime
      ? `Destroyed environment ${removed.name} (${removed.id}) and removed its pairing.`
      : forcedManaged
        ? `Force-removed pairing ${removed.name} (${removed.id}). Recipe-managed provider cleanup was intentionally skipped; this command did not verify that the resource is gone.`
        : `Removed pairing ${removed.name} (${removed.id}). No recipe-managed provider resource was associated, so no provider cleanup ran.`
  )
}

export type ProviderState = {
  runtimeId: string
  recipeId: string
  status: EphemeralVmRuntimeRecord['status']
  cleanupStatus: EphemeralVmRuntimeRecord['cleanupStatus']
  cleanupLastError?: string
  createdAt: number
  updatedAt: number
  result: EphemeralVmRuntimeRecord['recipeResult']
}

export function projectProviderState(
  runtime: EphemeralVmRuntimeRecord | undefined
): ProviderState | null {
  if (!runtime) {
    return null
  }
  return {
    runtimeId: runtime.id,
    recipeId: runtime.recipeId,
    status: runtime.status,
    cleanupStatus: runtime.cleanupStatus,
    ...(runtime.cleanupLastError ? { cleanupLastError: runtime.cleanupLastError } : {}),
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    result: redactEphemeralVmRecipeResultForDiagnostics(runtime.recipeResult)
  }
}

function loadRecipe(repoPath: string, recipeId: string): OrcaVmRecipe {
  const yamlPath = join(repoPath, 'orca.yaml')
  if (!existsSync(yamlPath)) {
    throw new RuntimeClientError('invalid_argument', `No orca.yaml found at ${yamlPath}`)
  }
  const hooks = parseOrcaYaml(readFileSync(yamlPath, 'utf8'))
  const recipe = hooks?.environmentRecipes?.find((entry) => entry.id === recipeId)
  if (!recipe) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Recipe not found: ${recipeId}. Add it to environmentRecipes in ${yamlPath}.`
    )
  }
  return recipe
}

function formatRecipeFailure(error: string, stderr: string, stdout: string): string {
  const detail =
    redactEphemeralVmRecipeDiagnosticText(stderr).trim() ||
    redactEphemeralVmRecipeDiagnosticText(stdout).trim()
  if (!detail) {
    return redactEphemeralVmRecipeDiagnosticText(error)
  }
  const maxDetailCharacters = 2_000
  const boundedDetail =
    detail.length <= maxDetailCharacters ? detail : `…${detail.slice(-maxDetailCharacters)}`
  return `${redactEphemeralVmRecipeDiagnosticText(error)}\nRecipe output:\n${boundedDetail}`
}

type AutomaticCleanupResult = { ok: true; skipped: boolean } | { ok: false; error: string }

function automaticCleanupFailureSuffix(args: {
  cleanup: AutomaticCleanupResult
  recipeId: string
  runtimeId: string
  pairingRetained: boolean
}): string {
  const retention = args.pairingRetained ? ' The pairing was retained for recovery.' : ''
  if (!args.cleanup.ok) {
    return ` Automatic cleanup failed: ${redactEphemeralVmRecipeDiagnosticText(args.cleanup.error)}.${retention}`
  }
  if (args.cleanup.skipped) {
    return ` Automatic cleanup was skipped because recipe ${args.recipeId} has no enabled destroy action. Provider runtime ${args.runtimeId} may still be running and must be cleaned up manually.${retention}`
  }
  return ''
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
