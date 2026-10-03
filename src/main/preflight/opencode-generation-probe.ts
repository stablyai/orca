/**
 * Classify the opencode CLI generation installed on the local execution host.
 *
 * Why not a binary-identity comparison (`realpath` equality across the two
 * commands): on Windows npm/pnpm install `opencode.cmd` and `opencode2.cmd` as
 * two distinct shim files that both target one `.exe`, so shim-path equality
 * never holds. The `--version` output is the actual v1/v2 discriminator, and it
 * is what issue #24987 verified on the reported machine.
 */
import path from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { classifyOpenCodeCliGeneration } from '../../shared/opencode-cli-generation'
import type { OpenCodeCliGeneration } from '../../shared/opencode-cli-generation'
import { resolveCliCommands } from '../../shared/node-cli-command-resolution'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'

// Why cached: agent detection re-runs on landing mounts and Refresh. The
// generation only changes when the user installs/uninstalls opencode, so a
// short TTL bounds staleness while collapsing each burst of probes onto one
// spawn. Keyed by the resolved binary so a replaced install reprobes. A failed
// probe is cached briefly so a transient error self-heals on Refresh.
const PROBE_TTL_MS = 60_000
const UNKNOWN_PROBE_TTL_MS = 5_000
const probes = new Map<
  string,
  { result: Promise<OpenCodeCliGeneration | null>; expiresAt: number }
>()
const MAX_PROBES = 8

/** @internal - tests need a clean probe cache between cases. */
export function resetLocalOpenCodeGenerationProbes(): void {
  probes.clear()
}

export async function detectLocalOpenCodeCliGeneration(): Promise<OpenCodeCliGeneration | null> {
  const environment = buildLocalPreflightEnv()
  const program = await resolveLocalOpenCodeProgram(environment)
  if (!program) {
    return null
  }
  const cached = probes.get(program)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }
  const result = probeOpenCodeGeneration(program, environment)
  const entry = { result, expiresAt: Number.POSITIVE_INFINITY }
  probes.set(program, entry)
  if (probes.size > MAX_PROBES) {
    const oldest = probes.keys().next().value
    if (oldest !== undefined) {
      probes.delete(oldest)
    }
  }
  const generation = await result
  entry.expiresAt = Date.now() + (generation ? PROBE_TTL_MS : UNKNOWN_PROBE_TTL_MS)
  return generation
}

// Why opencode first: v1 exposes only `opencode`; v2 exposes both. Resolving
// the shared name finds either generation, and the probe then tells which.
async function resolveLocalOpenCodeProgram(
  environment: Record<string, string> | undefined
): Promise<string | null> {
  const onPath =
    (await resolveCommandOnLocalPath('opencode', { env: environment })) ??
    (await resolveCommandOnLocalPath('opencode2', { env: environment }))
  if (onPath) {
    return onPath
  }
  // Why: detection also finds a CLI through install dirs on a cold GUI launch,
  // so the probe must classify the same binary or it suppresses a genuine v1
  // install (#24987). resolveCliCommands does NOT signal not-found — it echoes
  // the command name — so mirror detectCommandsInInstallDirs and accept only an
  // absolute path. Only PATH is overridden; platform/home keep the same
  // defaults detection already uses.
  const installDirs = resolveCliCommands(['opencode', 'opencode2'], {
    pathEnv: readPreflightPathEnv(environment)
  })
  for (const command of ['opencode', 'opencode2'] as const) {
    const resolved = installDirs.get(command)
    if (resolved && path.isAbsolute(resolved)) {
      return resolved
    }
  }
  return null
}

// Why: the preflight env may carry PATH under any case on Windows; reading only
// `PATH` would silently ignore the value the probe's spawn actually inherits.
function readPreflightPathEnv(environment: Record<string, string> | undefined): string | undefined {
  if (!environment) {
    return undefined
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === 'path') {
      return value
    }
  }
  return undefined
}

async function probeOpenCodeGeneration(
  program: string,
  environment: Record<string, string> | undefined
): Promise<OpenCodeCliGeneration | null> {
  try {
    const result = await runProcess({
      program,
      args: ['--version'],
      env: environment,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      return null
    }
    return classifyOpenCodeCliGeneration(result.stdout)
  } catch {
    // Probe failure is not proof of v1; the caller withholds the v1 id.
    return null
  }
}
