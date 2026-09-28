import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { CapabilityProbeCache } from '../../shared/capability-probe-cache'
import type { KiroUsageQuota, KiroUsageSnapshot } from '../../shared/kiro-usage-types'
import {
  isKiroUnsupportedEngineFlagOutput,
  isKiroV3EngineOutput,
  kiroAgentEngineArgs,
  KIRO_USAGE_ENGINE
} from '../../shared/kiro-cli-engine'
import { parseKiroUsageOutput } from './kiro-usage-parser'

const LOG_TAG = '[kiro-usage]'
// The CLI resolves the org profile and prints the meter in ~9-11s; give ample
// headroom so a slow-but-healthy run is not misread as a failure.
const USAGE_TIMEOUT_MS = 45_000
// Why: the CLI call is flaky (MCP load races, cold profile, transient network).
// A couple of quick retries turn most blips into a successful read instead of a
// vanished status bar.
const MAX_ATTEMPTS = 3
const RETRY_BACKOFF_MS = [750, 2_000]
// Why: a CLI too old for --agent-engine will not grow the flag mid-session, but
// an upgrade during a long-running Orca should be picked up before a restart.
const ENGINE_FLAG_RETRY_INTERVAL_MS = 30 * 60_000

const USAGE_ARGS = ['chat', '--no-interactive', '/usage'] as const

/** Keyed by resolved binary path so two CLIs on one machine cannot share a verdict. */
const engineFlagCapabilities = new CapabilityProbeCache<string>(ENGINE_FLAG_RETRY_INTERVAL_MS)

class KiroEngineFlagUnsupportedError extends Error {}

export type KiroUsageFetchOptions = {
  signal?: AbortSignal
  program?: string
  // Injectable for tests; defaults to the real runner and a real timer.
  run?: typeof runProcess
  sleep?: (ms: number) => Promise<void>
  engineCapabilities?: CapabilityProbeCache<string>
}

type AttemptOutcome =
  | { kind: 'ok'; quota: KiroUsageQuota }
  | { kind: 'retryable'; detail: string }
  // Retrying would only re-spend credits or repeat the same verdict.
  | { kind: 'fatal'; detail: string }

function snapshot(
  status: KiroUsageSnapshot['status'],
  quota: KiroUsageSnapshot['quota'],
  error: string | null
): KiroUsageSnapshot {
  return { status, quota, error, updatedAt: Date.now() }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// resolveCliCommand returns an absolute path when kiro-cli is found, or the bare
// command name when it is not. A bare name (no path separator) means the CLI is
// genuinely not installed — that is 'unavailable', never a transient error.
function isResolvedToInstalledBinary(program: string): boolean {
  return program.includes('/') || program.includes('\\')
}

function combinedOutput(result: ProcessResult): string {
  return `${result.stdout}\n${result.stderr}`
}

function classifyUsageResult(result: ProcessResult): AttemptOutcome {
  if (result.timedOut) {
    return { kind: 'retryable', detail: 'request timed out' }
  }
  const text = combinedOutput(result)
  const quota = parseKiroUsageOutput(text)
  if (quota) {
    return { kind: 'ok', quota }
  }
  if (isKiroV3EngineOutput(text)) {
    return {
      kind: 'fatal',
      detail: `the v3 agent engine answered /usage as a prompt; pin ${KIRO_USAGE_ENGINE} to read the plan meter`
    }
  }
  // Exit 0 with no meter is usually transient CLI noise (MCP load race) or a
  // momentary auth blip; a non-zero exit is likewise worth one more try.
  return {
    kind: 'retryable',
    detail: result.code === 0 ? 'no plan usage in output' : `kiro-cli exited ${result.code}`
  }
}

async function runUsageCommand(
  run: typeof runProcess,
  program: string,
  args: readonly string[],
  signal: AbortSignal | undefined
): Promise<ProcessResult> {
  return run({ program, args: [...args], timeoutMs: USAGE_TIMEOUT_MS, signal })
}

async function runUsageAttempt(
  run: typeof runProcess,
  program: string,
  signal: AbortSignal | undefined,
  capabilities: CapabilityProbeCache<string>
): Promise<AttemptOutcome> {
  const pinned = ['chat', ...kiroAgentEngineArgs(KIRO_USAGE_ENGINE), '--no-interactive', '/usage']
  return capabilities.runWithFallback(
    program,
    async () => {
      const result = await runUsageCommand(run, program, pinned, signal)
      if (result.code !== 0 && isKiroUnsupportedEngineFlagOutput(combinedOutput(result))) {
        throw new KiroEngineFlagUnsupportedError()
      }
      return classifyUsageResult(result)
    },
    async () => classifyUsageResult(await runUsageCommand(run, program, USAGE_ARGS, signal)),
    (error) => error instanceof KiroEngineFlagUnsupportedError
  )
}

// Run `kiro-cli chat --agent-engine v2 --no-interactive "/usage"`, parse the
// monthly plan meter, and retry transient failures. Never throws — returns a
// typed status so the caller can keep the last good value visible on a blip:
//   'ok'          -> fresh quota
//   'unavailable' -> kiro-cli is not installed (hide the provider)
//   'error'       -> installed but this fetch failed (keep stale data visible)
export async function fetchKiroUsage(
  options: KiroUsageFetchOptions = {}
): Promise<KiroUsageSnapshot> {
  const program = options.program ?? resolveCliCommand('kiro-cli')
  const run = options.run ?? runProcess
  const sleep = options.sleep ?? defaultSleep
  const capabilities = options.engineCapabilities ?? engineFlagCapabilities

  if (!isResolvedToInstalledBinary(program)) {
    return snapshot('unavailable', null, null)
  }

  let lastDetail = 'unknown error'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) {
      return snapshot('error', null, 'aborted')
    }
    let outcome: AttemptOutcome
    try {
      outcome = await runUsageAttempt(run, program, options.signal, capabilities)
    } catch (error) {
      // runProcess rejects only when the process could not be started. The
      // binary resolved to a real path, so treat this as transient/erroring
      // (installed but failing), not 'unavailable'.
      lastDetail = error instanceof Error ? error.message : String(error)
      outcome = { kind: 'retryable', detail: lastDetail }
    }
    if (outcome.kind === 'ok') {
      return snapshot('ok', outcome.quota, null)
    }
    lastDetail = outcome.detail
    if (outcome.kind === 'fatal') {
      break
    }
    const backoff = RETRY_BACKOFF_MS[attempt]
    if (attempt < MAX_ATTEMPTS - 1 && backoff !== undefined) {
      await sleep(backoff)
    }
  }

  console.warn(`${LOG_TAG} usage read failed: ${lastDetail}`)
  return snapshot('error', null, `Kiro usage unavailable: ${lastDetail}`)
}
