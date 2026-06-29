import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { parseOrcaYaml } from '../../shared/orca-yaml'
import {
  doctorEphemeralVmRecipe,
  getEphemeralVmRecipeResultProjectRoot,
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeDoctorCheck,
  type EphemeralVmRecipeDoctorResult
} from '../../shared/ephemeral-vm-recipes'
import {
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeStart
} from '../../shared/ephemeral-vm-recipe-runner'
import type { OrcaVmRecipe } from '../../shared/types'

export const VM_HANDLERS: Record<string, CommandHandler> = {
  'vm recipe doctor': async ({ flags, cwd, json }) => {
    const recipeId = getStringFlag(flags, 'recipe-id')
    if (!recipeId) {
      throw new RuntimeClientError('invalid_argument', 'Missing recipe id.')
    }
    const repoPath = getStringFlag(flags, 'repo-path') ?? cwd
    const shouldProvision = flags.get('provision') === true || flags.get('connect') === true
    const result = shouldProvision
      ? await doctorRecipeWithProvision(repoPath, recipeId)
      : doctorRecipe(repoPath, recipeId)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(formatDoctorResult(result))
    }
    if (!result.ok) {
      process.exitCode = 1
    }
  }
}

function doctorRecipe(repoPath: string, recipeId: string): DoctorResult {
  const yamlPath = join(repoPath, 'orca.yaml')
  if (!existsSync(yamlPath)) {
    return {
      recipeId,
      repoPath,
      ok: false,
      checks: [
        {
          id: 'orca_yaml.exists',
          status: 'fail',
          message: `No orca.yaml found at ${yamlPath}`,
          remediation: 'Add vmRecipes to the repo orca.yaml.'
        }
      ]
    }
  }

  const hooks = parseOrcaYaml(readTextFile(yamlPath))
  const parseCheck: EphemeralVmRecipeDoctorCheck = {
    id: 'orca_yaml.parse',
    status: hooks ? 'pass' : 'fail',
    message: hooks ? 'orca.yaml parsed successfully.' : 'orca.yaml has no supported Orca config.',
    ...(hooks ? {} : { remediation: 'Add a vmRecipes entry to orca.yaml.' })
  }
  const result = doctorEphemeralVmRecipe({
    repoPath,
    recipeId,
    recipes: hooks?.vmRecipes ?? [],
    localExecutionSupported: true
  })
  return {
    ...result,
    ok: parseCheck.status !== 'fail' && result.ok,
    checks: [parseCheck, ...result.checks]
  }
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8')
}

type DoctorResult = EphemeralVmRecipeDoctorResult

async function doctorRecipeWithProvision(
  repoPath: string,
  recipeId: string
): Promise<DoctorResult> {
  const baseline = doctorRecipe(repoPath, recipeId)
  if (!baseline.ok) {
    return {
      ...baseline,
      checks: [
        ...baseline.checks,
        {
          id: 'recipe.provision.skipped',
          status: 'fail',
          message: 'Provisioning was skipped because non-destructive doctor checks failed.',
          remediation: 'Fix the failing checks before running --provision again.'
        }
      ]
    }
  }

  const recipe = loadRecipe(repoPath, recipeId)
  if (!recipe) {
    return baseline
  }

  const start = await runEphemeralVmRecipeStart({ repoPath, recipe })
  if (!start.ok) {
    return {
      ...baseline,
      ok: false,
      checks: [
        ...baseline.checks,
        {
          id: 'recipe.provision',
          status: 'fail',
          message: start.error,
          remediation: buildProvisionFailureRemediation(start.stderr, start.stdout)
        }
      ]
    }
  }

  const checks: EphemeralVmRecipeDoctorCheck[] = [
    ...baseline.checks,
    {
      id: 'recipe.provision',
      status: 'pass',
      message: 'Recipe ran successfully and produced a valid VM recipe result.'
    },
    {
      id: 'recipe.result.project_root',
      status: 'pass',
      message: `Recipe returned projectRoot: ${getEphemeralVmRecipeResultProjectRoot(start.result)}`
    }
  ]
  for (const warning of getEphemeralVmRecipeResultWarnings(start.result)) {
    checks.push({
      id: warning.id,
      status: 'warn',
      message: warning.message,
      ...(warning.remediation ? { remediation: warning.remediation } : {})
    })
  }

  const cleanup = await runEphemeralVmRecipeCleanup({
    repoPath,
    recipe,
    context: start.context,
    recipeResult: start.result
  })
  if (cleanup.skipped) {
    checks.push({
      id: 'recipe.destroy.run',
      status: 'warn',
      message: 'Destroy was skipped because destroy is disabled or missing.',
      remediation: 'Destroy any provider resources created by the doctor run manually.'
    })
  } else if (cleanup.ok) {
    checks.push({
      id: 'recipe.destroy.run',
      status: 'pass',
      message: 'Destroy action ran successfully after provisioning.'
    })
  } else {
    checks.push({
      id: 'recipe.destroy.run',
      status: 'fail',
      message: cleanup.error ?? 'Destroy action failed after provisioning.',
      remediation: 'Destroy provider resources manually, then fix the destroy action.'
    })
  }

  return {
    ...baseline,
    ok: checks.every((check) => check.status !== 'fail'),
    checks
  }
}

function buildProvisionFailureRemediation(stderr: string, stdout: string): string {
  const redactedStderr = redactEphemeralVmRecipeDiagnosticText(stderr).trim()
  const redactedStdout = redactEphemeralVmRecipeDiagnosticText(stdout).trim()
  const detail = redactedStderr || redactedStdout
  return detail
    ? `Check recipe output. Last captured output: ${detail.slice(-500)}`
    : 'Check recipe stderr and ensure stdout contains the VM recipe result JSON.'
}

function loadRecipe(repoPath: string, recipeId: string): OrcaVmRecipe | null {
  const hooks = parseOrcaYaml(readTextFile(join(repoPath, 'orca.yaml')))
  return hooks?.vmRecipes?.find((entry) => entry.id === recipeId) ?? null
}

function formatDoctorResult(result: DoctorResult): string {
  return [
    `recipe: ${result.recipeId}`,
    `repoPath: ${result.repoPath}`,
    `ok: ${result.ok}`,
    ...result.checks.map((check) => {
      const suffix = check.remediation ? `\n  next: ${check.remediation}` : ''
      return `${check.status.toUpperCase()} ${check.id}: ${check.message}${suffix}`
    })
  ].join('\n')
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | null {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : null
}
