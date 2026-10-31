import { runProcess } from '@orca/process-host'
import { tmpdir } from 'node:os'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { hostShellEnvironment } from '../runtime/structured-agent-shell-environment'
import { parseMuseUsageStdout } from './muse-usage-response'

type MuseUsageOptions = {
  signal?: AbortSignal
  runCommand?: typeof runProcess
  resolveCommand?: typeof resolveCommandOnLocalPath
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  platform?: NodeJS.Platform
  now?: () => number
}

function failed(
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

function hasUsageCommand(help: string): boolean {
  const commands = stripAnsiEscapeSequences(help)
    .split(/^Commands:\s*$/m)[1]
    ?.split(/^\S/m)[0]
  return commands !== undefined && /^\s+usage(?:\s{2,}|$)/m.test(commands)
}

export async function fetchMuseRateLimits(
  options: MuseUsageOptions = {}
): Promise<ProviderRateLimits> {
  const now = options.now ?? Date.now
  const run = options.runCommand ?? runProcess
  const resolve = options.resolveCommand ?? resolveCommandOnLocalPath
  const resolveEnvironment = options.resolveEnvironment ?? hostShellEnvironment
  const cancelled = (): ProviderRateLimits =>
    failed('error', 'usage-unavailable', 'Muse usage refresh was cancelled.', now())
  if (options.signal?.aborted) {
    return cancelled()
  }

  try {
    const env = { ...(await resolveEnvironment()), MUSE_NO_AUTO_UPDATE: '1' }
    const cwd = tmpdir()
    const program = await resolve(TUI_AGENT_CONFIG.muse.detectCmd, {
      platform: options.platform ?? process.platform,
      env,
      cwd
    })
    if (options.signal?.aborted) {
      return cancelled()
    }
    if (!program) {
      return failed(
        'unavailable',
        'cli-unavailable',
        'Muse usage is unavailable. Install the Muse CLI on this machine.',
        now()
      )
    }

    const spec = { program, cwd, env, maxOutputBytes: 64 * 1024, signal: options.signal }
    // Older Muse versions can treat unknown subcommands as prompts; require the command before reading.
    const help = await run({ ...spec, args: ['--help'], timeoutMs: 5_000 })
    if (options.signal?.aborted) {
      return cancelled()
    }
    if (help.code !== 0 || help.signal !== null || help.timedOut || help.outputTruncated) {
      return failed(
        'error',
        'usage-unavailable',
        'Muse usage is unavailable. The CLI command support check did not complete.',
        now()
      )
    }
    if (!hasUsageCommand(help.stdout)) {
      return failed(
        'unavailable',
        'usage-unavailable',
        'Muse usage is unavailable. Update the Muse CLI to a version with the usage command.',
        now()
      )
    }

    const result = await run({ ...spec, args: ['usage', '--json'], timeoutMs: 15_000 })
    if (options.signal?.aborted) {
      return cancelled()
    }
    if (result.timedOut || result.signal !== null || result.outputTruncated) {
      return failed(
        'error',
        'usage-unavailable',
        'Muse usage is unavailable. The CLI did not complete the quota read.',
        now()
      )
    }
    if (result.code !== 0) {
      const diagnostic = `${result.stdout}\n${result.stderr}`
      if (/\bnot (?:logged|signed) in\b/i.test(diagnostic)) {
        return failed(
          'unavailable',
          'missing-credentials',
          'Muse usage is unavailable. Sign in with `muse` on this machine.',
          now()
        )
      }
      return failed(
        'error',
        'server',
        'Muse usage is unavailable. The CLI quota request failed.',
        now()
      )
    }
    const parsed = parseMuseUsageStdout(result.stdout, now())
    return (
      parsed ??
      failed(
        'error',
        'parse',
        'Muse usage is unavailable. The CLI returned an invalid quota response.',
        now()
      )
    )
  } catch {
    if (options.signal?.aborted) {
      return cancelled()
    }
    return failed(
      'error',
      'cli-unavailable',
      'Muse usage is unavailable. The CLI could not be started.',
      now()
    )
  }
}
