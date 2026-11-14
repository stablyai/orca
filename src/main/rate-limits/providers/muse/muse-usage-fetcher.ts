import { stat } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { stripAnsiEscapeSequences } from '../../../../shared/ansi-escape-sequences'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../../../shared/rate-limit-types'
import { resolveCommandOnLocalPath } from '../../../ipc/command-path/command-path-resolver'
import { hostShellEnvironment } from '../../../runtime/agent-session/environment/structured-agent-shell-environment'
import { resolveHiddenProbeCwd } from '../../../lib/hidden-probe-cwd'
import { parseMuseUsageStdout } from './muse-usage-response'
import { readMuseVersionFile, resolveMuseInstall } from './muse-install-layout'

// `muse usage --json` reads the subscription allowance without a model turn (Muse 1.4.13+).
const MUSE_USAGE_ARGS: readonly string[] = ['usage', '--json']
const MUSE_HELP_ARGS: readonly string[] = ['--help']
// The shared fetch queue waits for Muse, so cap the whole probe near 8s. Warm reads take ~1s.
const MUSE_USAGE_TIMEOUT_MS = 6_000
const MUSE_HELP_TIMEOUT_MS = 2_000
const MUSE_MAX_OUTPUT_BYTES = 64 * 1024
// The launcher must not self-update or start a device sign-in from a background poll.
const MUSE_PROBE_ENV = {
  MUSE_NO_AUTO_UPDATE: '1',
  MUSE_LOGIN: '0',
  MUSE_LAUNCHER_INSTALL: '0'
} as const

export type FetchMuseRateLimitsOptions = {
  signal?: AbortSignal
  runCommand?: typeof runProcess
  resolveCommand?: typeof resolveCommandOnLocalPath
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveCwd?: () => string
  platform?: NodeJS.Platform
  now?: () => number
}

function failure(
  status: 'unavailable' | 'error',
  failureKind: UsageRateLimitFailureKind,
  error: string,
  updatedAt: number
): ProviderRateLimits {
  return {
    provider: 'muse',
    session: null,
    weekly: null,
    updatedAt,
    error,
    status,
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], failureKind }
  }
}

// Older Muse builds treat an unknown subcommand as a prompt, so only call `usage` once help lists it.
export function museHelpListsUsageCommand(help: string): boolean {
  const commands = stripAnsiEscapeSequences(help)
    .split(/^Commands:\s*$/m)[1]
    ?.split(/^\S/m)[0]
  return commands !== undefined && /^\s+usage(?:\s{2,}|\s*$)/m.test(commands)
}

// Help-text answers for installs without `.muse-version`, keyed by launcher path, mtime and size.
let museHelpCache: { key: string; listsUsage: boolean } | null = null

async function launcherIdentity(launcherPath: string): Promise<string | null> {
  try {
    const info = await stat(launcherPath)
    return `${launcherPath}\0${info.mtimeMs}\0${info.size}`
  } catch {
    return null
  }
}

function showsSignedOut(output: string): boolean {
  // Muse 1.4.14 prints "not logged in: run `muse login` first".
  return /\bnot (?:logged|signed) in\b/i.test(output)
}

// Runs on the execution owner's machine; remote owners publish their own Muse reading.
export async function fetchMuseRateLimits(
  options: FetchMuseRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const now = options.now ?? Date.now
  const run = options.runCommand ?? runProcess
  const resolve = options.resolveCommand ?? resolveCommandOnLocalPath
  const resolveEnvironment = options.resolveEnvironment ?? (() => hostShellEnvironment())
  const cancelled = (): ProviderRateLimits =>
    failure('error', 'usage-unavailable', 'Muse usage refresh was cancelled.', now())

  try {
    // Muse lives on the login-shell PATH, not Electron's.
    const env = { ...(await resolveEnvironment()), ...MUSE_PROBE_ENV }
    const program = await resolve(TUI_AGENT_CONFIG.muse.detectCmd, {
      platform: options.platform ?? process.platform,
      env
    })
    if (options.signal?.aborted) {
      return cancelled()
    }
    if (!program) {
      return failure(
        'unavailable',
        'cli-unavailable',
        'Muse usage is unavailable. The Muse CLI (`muse`) was not found on this machine.',
        now()
      )
    }
    const install = await resolveMuseInstall(program)
    const spec = {
      program: install.program,
      env,
      cwd: (options.resolveCwd ?? resolveHiddenProbeCwd)(),
      maxOutputBytes: MUSE_MAX_OUTPUT_BYTES,
      signal: options.signal
    }

    const needsUpdate = (): ProviderRateLimits =>
      failure(
        'unavailable',
        'usage-unavailable',
        'Muse usage needs a newer Muse CLI with the `muse usage` command. Update Muse to show quota.',
        now()
      )
    if (install.kind === 'versioned') {
      if (!install.supportsUsage) {
        return needsUpdate()
      }
    } else {
      const helpKey = await launcherIdentity(install.launcherPath)
      let listsUsage =
        helpKey !== null && museHelpCache?.key === helpKey ? museHelpCache.listsUsage : null
      if (listsUsage === null) {
        const help = await run({ ...spec, args: MUSE_HELP_ARGS, timeoutMs: MUSE_HELP_TIMEOUT_MS })
        if (options.signal?.aborted) {
          return cancelled()
        }
        if (help.code !== 0 || help.timedOut || help.signal !== null) {
          return failure(
            'error',
            'usage-unavailable',
            'Muse usage is unavailable. The Muse CLI did not answer `muse --help`.',
            now()
          )
        }
        listsUsage = museHelpListsUsageCommand(help.stdout)
        museHelpCache = helpKey === null ? museHelpCache : { key: helpKey, listsUsage }
      }
      if (!listsUsage) {
        return needsUpdate()
      }
    }

    const result = await run({ ...spec, args: MUSE_USAGE_ARGS, timeoutMs: MUSE_USAGE_TIMEOUT_MS })
    if (options.signal?.aborted) {
      return cancelled()
    }
    // A Muse update swapped the active build mid-call; don't trust that reading.
    if (
      install.kind === 'versioned' &&
      (await readMuseVersionFile(install.versionFile)) !== install.version
    ) {
      return failure(
        'error',
        'usage-unavailable',
        'Muse usage is unavailable. Muse updated during the refresh.',
        now()
      )
    }
    if (result.timedOut || result.signal !== null) {
      return failure(
        'error',
        'usage-unavailable',
        'Muse usage is unavailable. The Muse CLI did not answer in time.',
        now()
      )
    }
    if (result.code !== 0) {
      return showsSignedOut(`${result.stdout}\n${result.stderr}`)
        ? failure(
            'unavailable',
            'missing-credentials',
            'Muse usage is unavailable. Sign in with `muse login`, then refresh usage.',
            now()
          )
        : failure(
            'error',
            'server',
            'Muse usage is unavailable. The Muse allowance request failed.',
            now()
          )
    }
    const reading = parseMuseUsageStdout(result.stdout, now())
    if (!reading) {
      return failure(
        'error',
        'parse',
        'Muse usage is unavailable. The Muse CLI returned an unrecognized usage response.',
        now()
      )
    }
    return reading.kind === 'ok'
      ? reading.limits
      : failure('unavailable', reading.failureKind, reading.message, now())
  } catch (error) {
    if (options.signal?.aborted) {
      return cancelled()
    }
    return failure(
      'error',
      'cli-unavailable',
      `Muse usage is unavailable. The Muse CLI could not be started: ${error instanceof Error ? error.message : 'unknown error'}.`,
      now()
    )
  }
}
