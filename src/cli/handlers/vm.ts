import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { parseOrcaYaml } from '../../shared/orca-yaml'
import {
  getEphemeralVmRecipeResultProjectRoot,
  getEphemeralVmRecipeResultWarnings,
  redactEphemeralVmRecipeDiagnosticText,
  type EphemeralVmRecipeDoctorCheck,
  type EphemeralVmRecipeDoctorResult
} from '../../shared/ephemeral-vm-recipes'
// Why: import directly from the doctor module (not the barrel) — it uses Node
// fs/path and must stay out of the browser bundle that imports the barrel.
import { doctorEphemeralVmRecipe } from '../../shared/ephemeral-vm-recipe-doctor'
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
          remediation: 'Add environmentRecipes to the repo orca.yaml.'
        }
      ]
    }
  }

  const hooks = parseOrcaYaml(readTextFile(yamlPath))
  const parseCheck: EphemeralVmRecipeDoctorCheck = {
    id: 'orca_yaml.parse',
    status: hooks ? 'pass' : 'fail',
    message: hooks ? 'orca.yaml parsed successfully.' : 'orca.yaml has no supported Orca config.',
    ...(hooks ? {} : { remediation: 'Add an environmentRecipes entry to orca.yaml.' })
  }
  const result = doctorEphemeralVmRecipe({
    repoPath,
    recipeId,
    recipes: hooks?.environmentRecipes ?? [],
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

// Why: give the agent the full create/destroy output so it can self-diagnose a
// failed provision instead of relaying logs through the user. Each stream is
// redacted and capped (head+tail) so a huge log stays readable but complete enough.
type ProvisionStageTranscript = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  parseError?: string
}

type ProvisionTranscript = {
  provision: ProvisionStageTranscript
  destroy?: ProvisionStageTranscript
}

type DoctorResult = EphemeralVmRecipeDoctorResult & {
  provisionTranscript?: ProvisionTranscript
}

const MAX_TRANSCRIPT_STREAM_BYTES = 16_000

// Why: keep both ends of a long log — the script's setup context (head) and the
// failure itself (tail) — rather than only the last 500 chars.
function capTranscriptStream(value: string): string {
  const redacted = redactEphemeralVmRecipeDiagnosticText(value)
  if (redacted.length <= MAX_TRANSCRIPT_STREAM_BYTES) {
    return redacted
  }
  const half = Math.floor(MAX_TRANSCRIPT_STREAM_BYTES / 2)
  const omitted = redacted.length - half * 2
  return `${redacted.slice(0, half)}\n…[${omitted} chars omitted]…\n${redacted.slice(-half)}`
}

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
      ],
      // Why: the create script failed — hand the agent the complete output (not a
      // tail) so it can see what the script printed and why parsing/exit failed.
      provisionTranscript: {
        provision: {
          exitCode: start.exitCode,
          signal: start.signal,
          stdout: capTranscriptStream(start.stdout),
          stderr: capTranscriptStream(start.stderr),
          parseError: start.error
        }
      }
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

  // Why: include both stages' full output even on success — the agent can confirm
  // pairing/teardown looked right, and diagnose a destroy failure without re-running.
  const provisionTranscript: ProvisionTranscript = {
    provision: {
      exitCode: 0,
      signal: null,
      stdout: capTranscriptStream(start.stdout),
      stderr: capTranscriptStream(start.stderr)
    },
    ...(cleanup.skipped
      ? {}
      : {
          destroy: {
            exitCode: cleanup.exitCode,
            signal: cleanup.signal,
            stdout: capTranscriptStream(cleanup.stdout),
            stderr: capTranscriptStream(cleanup.stderr)
          }
        })
  }

  return {
    ...baseline,
    ok: checks.every((check) => check.status !== 'fail'),
    checks,
    provisionTranscript
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
  return hooks?.environmentRecipes?.find((entry) => entry.id === recipeId) ?? null
}

function formatDoctorResult(result: DoctorResult): string {
  const lines = [
    `recipe: ${result.recipeId}`,
    `repoPath: ${result.repoPath}`,
    `ok: ${result.ok}`,
    ...result.checks.map((check) => {
      const suffix = check.remediation ? `\n  next: ${check.remediation}` : ''
      return `${check.status.toUpperCase()} ${check.id}: ${check.message}${suffix}`
    })
  ]
  if (result.provisionTranscript) {
    lines.push(...formatTranscriptStage('create', result.provisionTranscript.provision))
    if (result.provisionTranscript.destroy) {
      lines.push(...formatTranscriptStage('destroy', result.provisionTranscript.destroy))
    }
  }
  return lines.join('\n')
}

function formatTranscriptStage(label: string, stage: ProvisionStageTranscript): string[] {
  const out = [`--- ${label} (exit ${stage.exitCode ?? stage.signal ?? 'unknown'}) ---`]
  if (stage.parseError) {
    out.push(`parseError: ${stage.parseError}`)
  }
  if (stage.stdout.trim()) {
    out.push(`stdout:\n${stage.stdout}`)
  }
  if (stage.stderr.trim()) {
    out.push(`stderr:\n${stage.stderr}`)
  }
  return out
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | null {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : null
}
