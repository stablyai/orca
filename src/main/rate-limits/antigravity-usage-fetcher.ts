import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import type { LocalAccountRuntimeTarget } from '../../shared/local-account-runtime'
import { runWslProcess } from '../wsl/wsl-runner'
import { isWslDistroRunningForBackgroundWork } from '../wsl-background-distro-gate'
import { hasReachedAppVersion, parseCliVersion } from '../../shared/app-version'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { hostShellEnvironment } from '../runtime/structured-agent-shell-environment'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import {
  ANTIGRAVITY_MIN_USAGE_VERSION,
  ANTIGRAVITY_PROBE_ENV,
  ANTIGRAVITY_SIGN_IN_PROMPT_COOLDOWN_MS,
  ANTIGRAVITY_USAGE_ARGS,
  ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
  ANTIGRAVITY_USAGE_TIMEOUT_MS,
  ANTIGRAVITY_VERSION_ARGS,
  ANTIGRAVITY_VERSION_TIMEOUT_MS,
  antigravityCommandName
} from './antigravity-usage-command'
import {
  parseAntigravityUsageStdout,
  readAntigravityErrorEnvelope,
  stdoutShowsModelTurn
} from './antigravity-usage-response'
import {
  classifyAntigravityUsageFailure,
  formatAgyErrorForDisplay,
  stderrShowsInteractiveSignIn
} from './antigravity-usage-error'

const FAILURE_REASONS: Partial<Record<UsageRateLimitFailureKind, string>> = {
  'rate-limited':
    'Antigravity usage is not available right now. The Antigravity API is rate-limiting this account.',
  'no-subscription':
    'Antigravity usage is not available. This account is signed in but not entitled to Antigravity quota.',
  server:
    'Antigravity usage is not available right now. The Antigravity API returned a server error.'
}

const UNSUPPORTED_USAGE_COMMAND_REASON =
  'Antigravity usage is not available. This version of the Antigravity CLI answers `/usage` as a prompt instead of a command, so Orca stopped asking rather than spend quota on it. Update `agy` and restart Orca.'

// Latch unsupported after any model-turn response: discovering unsupported /usage spends quota, so never retry it for process lifetime.
// Keyed by runtime: host and each WSL distro run their own agy.
const unsupportedUsageRuntimes = new Set<string>()

/** Clears the unsupported latch. Tests only — a live process has no way back. */
export function resetAntigravityUsageSupportForTests(): void {
  unsupportedUsageRuntimes.clear()
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
  /** A WSL target reads the agy installed and signed in inside that distro. */
  target?: LocalAccountRuntimeTarget
}

type AgyRun = (args: readonly string[], timeoutMs: number) => Promise<ProcessResult>

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
    // Report absent CLI/signed-out account as actionable unavailable guidance, not recurring refresh error (#7809,#14227).
    status: 'unavailable',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], failureKind }
  }
}

function spawnFailureMessage(error: unknown): string {
  return `Antigravity usage is not available. The Antigravity CLI could not be started: ${error instanceof Error ? error.message : 'unknown error'}.`
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

// Read agy’s weekly Antigravity pools, not Gemini’s 60-minute per-model quota mislabeled as Antigravity (#9122,#22511); no Gemini CLI dependency.
// Run on execution owner’s machine; caller must not query local agy for a remote workspace.
export async function fetchAntigravityRateLimits(
  options: FetchAntigravityRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const wsl = options.target?.runtime === 'wsl' ? options.target : null
  const runtimeKey = wsl ? `wsl:${wsl.wslDistro ?? ''}` : 'host'
  const result = await readAntigravityUsage(options, wsl, runtimeKey)
  // Lets the service drop the previous runtime's reading instead of keeping it as stale.
  return { ...result, usageMetadata: { ...result.usageMetadata, authProvenance: runtimeKey } }
}

async function readAntigravityUsage(
  options: FetchAntigravityRateLimitsOptions,
  wsl: LocalAccountRuntimeTarget | null,
  runtimeKey: string
): Promise<ProviderRateLimits> {
  const now = options.now ?? Date.now
  if (unsupportedUsageRuntimes.has(runtimeKey)) {
    return unavailable(UNSUPPORTED_USAGE_COMMAND_REASON, 'usage-unavailable', now())
  }
  const command = antigravityCommandName()
  const wslLabel = `WSL (${wsl?.wslDistro ?? 'default distro'})`
  const location = wsl ? `in ${wslLabel}` : 'on this machine'
  const notFound = (): ProviderRateLimits =>
    unavailable(
      `Antigravity usage is not available. The Antigravity CLI (\`${command}\`) was not found ${location}.`,
      'cli-unavailable',
      now()
    )

  let run: AgyRun
  if (wsl) {
    // Background quota polling must not start stopped distros.
    if (!(await isWslDistroRunningForBackgroundWork(wsl.wslDistro))) {
      return unavailable(
        `Antigravity usage is not available while ${wslLabel} is not running.`,
        'cli-unavailable',
        now()
      )
    }
    run = async (args, timeoutMs) => ({
      ...(await runWslProcess({
        distro: wsl.wslDistro ?? undefined,
        loginPath: 'preferred',
        program: command,
        args,
        env: ANTIGRAVITY_PROBE_ENV,
        timeoutMs,
        maxOutputBytes: ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
        signal: options.signal
      })),
      signal: null
    })
  } else {
    const resolve = options.resolveCommand ?? resolveCommandOnLocalPath
    const platform = options.platform ?? process.platform
    const resolveEnvironment = options.resolveEnvironment ?? (() => hostShellEnvironment())
    // Why the env agent launches use: agy lives on the login-shell or saved Windows PATH, not Electron's.
    const env = { ...(await resolveEnvironment()), ...ANTIGRAVITY_PROBE_ENV }
    const program = await resolve(command, { platform, env })
    if (!program) {
      return notFound()
    }
    const runCommand = options.runCommand ?? runProcess
    run = (args, timeoutMs) =>
      runCommand({
        program,
        args,
        env,
        timeoutMs,
        maxOutputBytes: ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
        signal: options.signal
      })
  }

  // Recheck each read: the CLI can be replaced while Orca runs; unsupported reads spend quota.
  let versionRun: ProcessResult
  try {
    versionRun = await run(ANTIGRAVITY_VERSION_ARGS, ANTIGRAVITY_VERSION_TIMEOUT_MS)
  } catch (error) {
    return failed(spawnFailureMessage(error), 'cli-unavailable', now())
  }
  // WSL skips the host PATH lookup; the guest reports a missing agy as exit 127.
  if (wsl && versionRun.code === 127) {
    return notFound()
  }
  const version =
    versionRun.code === 0 && !versionRun.timedOut && versionRun.signal === null
      ? parseCliVersion(versionRun.stdout.trim() ? versionRun.stdout : versionRun.stderr)
      : null
  if (!version || !hasReachedAppVersion(version, ANTIGRAVITY_MIN_USAGE_VERSION)) {
    return unavailable(
      version
        ? `Antigravity usage needs agy ${ANTIGRAVITY_MIN_USAGE_VERSION} or newer (found ${version}). Update the agy CLI to show quota in the status bar.`
        : `Antigravity usage is unavailable because the agy CLI version could not be read. Update agy to ${ANTIGRAVITY_MIN_USAGE_VERSION} or newer.`,
      'usage-unavailable',
      now()
    )
  }

  let result: ProcessResult
  try {
    result = await run(ANTIGRAVITY_USAGE_ARGS, ANTIGRAVITY_USAGE_TIMEOUT_MS)
  } catch (error) {
    return failed(spawnFailureMessage(error), 'cli-unavailable', now())
  }

  const reading = parseAntigravityUsageStdout(result.stdout)
  // Why: a completed browser sign-in still yields a reading; only a failed read cools down.
  if (
    !reading &&
    (result.timedOut || result.code !== 0) &&
    stderrShowsInteractiveSignIn(result.stderr)
  ) {
    const at = now()
    return {
      ...unavailable(
        'Antigravity usage is not available. Sign in with `agy`; Orca checks again within an hour, or when you refresh.',
        'missing-credentials',
        at
      ),
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        failureKind: 'missing-credentials',
        retryAtMs: at + ANTIGRAVITY_SIGN_IN_PROMPT_COOLDOWN_MS
      }
    }
  }
  if (result.timedOut) {
    return failed(
      'Antigravity usage is not available. The Antigravity CLI did not answer in time.',
      'usage-unavailable',
      now()
    )
  }

  // Check valid reading before model-turn evidence so successful quota response cannot falsely latch unsupported.
  if (!reading && stdoutShowsModelTurn(result.stdout)) {
    unsupportedUsageRuntimes.add(runtimeKey)
    return unavailable(UNSUPPORTED_USAGE_COMMAND_REASON, 'usage-unavailable', now())
  }
  if (!reading) {
    const failure = classifyAntigravityUsageFailure(`${result.stdout}\n${result.stderr}`)
    if (failure?.signedOut) {
      return unavailable(
        'Antigravity usage is not available. Sign in with `agy` to report this account’s quota.',
        failure.failureKind,
        now()
      )
    }
    if (failure) {
      return failed(
        FAILURE_REASONS[failure.failureKind] ??
          'Antigravity usage is not available. The CLI could not read this account’s quota.',
        failure.failureKind,
        now()
      )
    }
    const agyError = formatAgyErrorForDisplay(readAntigravityErrorEnvelope(result.stdout) ?? '')
    if (agyError) {
      return failed(`Antigravity usage is not available. agy reported: ${agyError}`, 'parse', now())
    }
    // runProcess returns nonzero exit as data; classify signed-out first and add exit detail only when payload is missing.
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
