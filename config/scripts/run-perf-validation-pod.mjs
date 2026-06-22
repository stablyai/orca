import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildPerfValidationPodScaffold,
  buildPerfValidationRunPlan
} from './perf-validation-pod-scaffold.mjs'

const DEFAULT_ARTIFACT_ROOT = '.perf-validation'

function requireValue(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

export function parseRunPerfValidationPodArgs(argv, env = process.env) {
  const options = {
    artifactRoot: env.ORCA_PERF_VALIDATION_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT,
    pod: env.ORCA_PERF_VALIDATION_POD || null,
    runId: env.ORCA_PERF_VALIDATION_RUN_ID || null,
    variant: null
  }

  if (argv[0] === '--') {
    argv = argv.slice(1)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--pod') {
      options.pod = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--run-id') {
      options.runId = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--artifact-root') {
      options.artifactRoot = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--variant') {
      options.variant = requireValue(argv, index, arg)
      index += 1
    } else if (arg === '--help') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (options.help) {
    return options
  }
  if (!options.pod) {
    throw new Error('--pod is required')
  }
  if (!options.runId) {
    throw new Error('--run-id is required')
  }
  if (!['baseline', 'candidate'].includes(options.variant)) {
    throw new Error('--variant must be baseline or candidate')
  }
  return options
}

function commandOutput(result, key) {
  const value = result[key]
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
  return text.replace(/\s+$/u, '')
}

function rawCommandOutput(result, key) {
  const value = result[key]
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
}

export function runPerfValidationPodVariant({
  env = process.env,
  mkdirSyncImpl = mkdirSync,
  scaffold,
  spawnSyncImpl = spawnSync,
  variant,
  writeFileSyncImpl = writeFileSync
}) {
  const runPlan = buildPerfValidationRunPlan(scaffold, variant)
  mkdirSyncImpl(scaffold.artifactDir, { recursive: true })

  for (const step of runPlan.steps) {
    const stepEnv = step.env ? { ...env, ...step.env } : env
    const result = spawnSyncImpl(step.command, step.args, {
      cwd: scaffold.worktreePath,
      encoding: 'utf8',
      env: stepEnv
    })
    if (step.stdoutFile) {
      writeFileSyncImpl(step.stdoutFile, rawCommandOutput(result, 'stdout'))
    }

    const status = result.status ?? (result.signal ? 1 : 0)
    if (status !== 0) {
      return {
        ok: false,
        reason: commandOutput(result, 'stderr') || commandOutput(result, 'stdout'),
        status
      }
    }
  }

  return { ok: true, status: 0 }
}

function usage() {
  return `Usage: node config/scripts/run-perf-validation-pod.mjs --pod <name> --run-id <id> --variant <baseline|candidate> [options]\n\nOptions:\n  --artifact-root <dir> Durable artifact root (default ${DEFAULT_ARTIFACT_ROOT})\n`
}

export function runPerfValidationPodCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stdout = console.log
} = {}) {
  try {
    const options = parseRunPerfValidationPodArgs(argv, env)
    if (options.help) {
      stdout(usage())
      return 0
    }
    const scaffold = buildPerfValidationPodScaffold({ ...options, cwd })
    const result = runPerfValidationPodVariant({ env, scaffold, variant: options.variant })
    if (!result.ok && result.reason) {
      console.error(result.reason)
    }
    return result.status
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runPerfValidationPodCli())
}
