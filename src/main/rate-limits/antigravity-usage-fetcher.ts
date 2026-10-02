import { runProcess } from '../../shared/child-process/run-process'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import {
  ANTIGRAVITY_USAGE_ARGS,
  ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
  ANTIGRAVITY_USAGE_TIMEOUT_MS,
  antigravityCommandName
} from './antigravity-usage-command'
import { parseAntigravityUsageStdout, stdoutShowsModelTurn } from './antigravity-usage-response'

/**
 * Observed verbatim in agy's own log when the keyring holds no session. agy exits 0 and prints this
 * instead of a usage envelope, so the text is the only thing that separates "signed out" from
 * "answered nothing".
 */
const NOT_SIGNED_IN_MARKER = 'not logged into antigravity'

const UNSUPPORTED_USAGE_COMMAND_REASON =
  'Antigravity usage is not available. This version of the Antigravity CLI answers `/usage` as a prompt instead of a command, so Orca stopped asking rather than spend quota on it. Update `agy` and restart Orca.'

/**
 * Latched once agy answers the quota read with a model turn.
 *
 * Why latch instead of retrying: the evidence that this agy cannot answer `/usage` is the same
 * event that spends a turn of the user's quota. Retrying on a cadence would keep paying for the
 * same discovery, so the probe is abandoned for the rest of the process's life.
 */
let usageCommandUnsupported = false

/** Clears the unsupported latch. Tests only — a live process has no way back. */
export function resetAntigravityUsageSupportForTests(): void {
  usageCommandUnsupported = false
}

export type AntigravityUsageDependencies = {
  /** Injected so tests exercise the classification without spawning agy. */
  runCommand?: typeof runProcess
  resolveCommand?: typeof resolveCommandOnLocalPath
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  platform?: NodeJS.Platform
  now?: () => number
}

export type FetchAntigravityRateLimitsOptions = AntigravityUsageDependencies & {
  signal?: AbortSignal
}

function unavailable(
  message: string,
  failureKind: UsageRateLimitFailureKind,
  now: number
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error: message,
    // Why 'unavailable' and not 'error' for every failure: an absent CLI or a signed-out account is
    // a state the user can act on, and the status bar renders it as guidance rather than as a
    // refresh that keeps failing (#7809, #14227).
    status: 'unavailable',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], failureKind }
  }
}

function failed(
  message: string,
  failureKind: UsageRateLimitFailureKind,
  now: number
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error: message,
    status: 'error',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], failureKind }
  }
}

/**
 * Reads Antigravity quota from the Antigravity CLI itself.
 *
 * Why the CLI and not the Gemini mirror it replaces: Orca used to publish a *successful* Gemini
 * `retrieveUserQuota` read under the Antigravity provider id. That reported Gemini CLI per-model
 * buckets on a 60-minute window, so Antigravity's real pools ("Gemini Models" and "Claude and GPT
 * models", each weekly) were never shown and the weekly limit was always null (#9122, #22511). It
 * also made the segment depend on an installed `@google/gemini-cli` for token refresh, which an
 * Antigravity user has no reason to have.
 *
 * This runs on whichever machine owns execution; the caller is responsible for not asking a local
 * agy about a remote workspace's quota.
 */
export async function fetchAntigravityRateLimits(
  options: FetchAntigravityRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const now = options.now ?? Date.now
  if (usageCommandUnsupported) {
    return unavailable(UNSUPPORTED_USAGE_COMMAND_REASON, 'usage-unavailable', now())
  }
  const run = options.runCommand ?? runProcess
  const resolve = options.resolveCommand ?? resolveCommandOnLocalPath
  const platform = options.platform ?? process.platform
  const resolveEnvironment = options.resolveEnvironment ?? (() => resolveLoginShellEnvironment())

  // Why the login shell's env: agy installs to ~/.local/bin, which is on the user's PATH but not on
  // the PATH an Electron app inherits from the window server or a desktop launcher.
  const env = await resolveEnvironment()
  const command = antigravityCommandName()
  const program = await resolve(command, { platform, env })
  if (!program) {
    return unavailable(
      `Antigravity usage is not available. The Antigravity CLI (\`${command}\`) was not found on this machine.`,
      'cli-unavailable',
      now()
    )
  }

  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await run({
      program,
      args: ANTIGRAVITY_USAGE_ARGS,
      env,
      timeoutMs: ANTIGRAVITY_USAGE_TIMEOUT_MS,
      maxOutputBytes: ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
      signal: options.signal
    })
  } catch (error) {
    return failed(
      `Antigravity usage is not available. The Antigravity CLI could not be started: ${error instanceof Error ? error.message : 'unknown error'}.`,
      'cli-unavailable',
      now()
    )
  }

  if (result.timedOut) {
    return failed(
      'Antigravity usage is not available. The Antigravity CLI did not answer in time.',
      'usage-unavailable',
      now()
    )
  }

  const output = `${result.stdout}\n${result.stderr}`
  if (output.toLowerCase().includes(NOT_SIGNED_IN_MARKER)) {
    return unavailable(
      'Antigravity usage is not available. Sign in with `agy` to report this account’s quota.',
      'missing-credentials',
      now()
    )
  }

  const reading = parseAntigravityUsageStdout(result.stdout)
  // Why the successful read is checked first: a real reading can never be evidence of a prompt, so
  // ordering it ahead of the turn check makes a false latch impossible.
  if (!reading && stdoutShowsModelTurn(result.stdout)) {
    usageCommandUnsupported = true
    return unavailable(UNSUPPORTED_USAGE_COMMAND_REASON, 'usage-unavailable', now())
  }
  if (!reading) {
    // Why a non-zero exit is reported only here: `runProcess` treats the exit code as data, and agy
    // exits 0 for a signed-out read, so the code only adds detail once the payload is missing.
    const exitDetail = result.code === 0 || result.code === null ? '' : ` (exit ${result.code})`
    return failed(
      `Antigravity usage is not available. The Antigravity CLI did not report a quota${exitDetail}.`,
      'parse',
      now()
    )
  }

  return {
    provider: 'antigravity',
    session: reading.session,
    weekly: reading.weekly,
    buckets: reading.buckets.map(({ id: _id, ...bucket }) => bucket),
    updatedAt: now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'cli',
      attemptedSources: ['cli'],
      lastSuccessfulSource: 'cli',
      credentialSource: 'antigravity-cli'
    }
  }
}
