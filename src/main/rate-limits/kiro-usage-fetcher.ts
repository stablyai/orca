import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { runProcess } from '../../shared/child-process/run-process'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const CLI_TIMEOUT_MS = 20_000
const MONTHLY_WINDOW_MINUTES = 43_200

type CommandResult = { stdout: string; stderr: string }
type CommandRunner = (
  command: string,
  args: string[],
  signal?: AbortSignal
) => Promise<CommandResult>

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  monthly: RateLimitWindow | null = null,
  planType: string | null = null,
  failureKind?: 'cli-unavailable' | 'parse' | 'usage-unavailable'
): ProviderRateLimits {
  return {
    provider: 'kiro',
    session: null,
    weekly: null,
    monthly,
    planType,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'cli',
      ...(failureKind ? { failureKind } : {})
    }
  }
}

export function resolveKiroCommand(
  options: {
    pathEnv?: string | null
    platform?: NodeJS.Platform
    homePath?: string
  } = {}
): string {
  const configured = process.env.KIRO_CLI_PATH?.trim()
  if (configured) {
    return configured
  }
  return resolveCliCommand('kiro-cli', options)
}

const runCommand: CommandRunner = async (command, args, signal) => {
  const result = await runProcess({
    program: command,
    args,
    env: withCliRuntimeOnPath(command, { ...process.env }),
    timeoutMs: CLI_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
    killOnOutputLimit: true,
    signal
  })
  if (result.code !== 0 || result.timedOut || result.signal || result.outputTruncated) {
    throw new Error('Kiro usage command failed')
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

export function parseKiroUsageOutput(output: string): ProviderRateLimits {
  const readable = stripAnsiEscapeSequences(output).replace(/\r/g, '')
  const header = readable.match(/Estimated Usage\s*\|\s*resets on\s+([^|\n]+?)\s*\|\s*([^\n]+)/i)
  const resetDescription = header?.[1].trim()
  const credits = readable.match(/Credits\s*\(([\d,.]+)\s+of\s+([\d,.]+)\s+covered in plan\)/i)
  const percent = readable.match(/(?:^|\s)(\d+(?:\.\d+)?)%\s*$/m)
  const used = credits ? Number(credits[1].replaceAll(',', '')) : Number.NaN
  const limit = credits ? Number(credits[2].replaceAll(',', '')) : Number.NaN
  const usedPercent =
    Number.isFinite(used) && Number.isFinite(limit) && limit > 0
      ? Math.min(100, Math.max(0, (used / limit) * 100))
      : percent
        ? Math.min(100, Math.max(0, Number(percent[1])))
        : null
  if (!header || !resetDescription || usedPercent === null || !Number.isFinite(usedPercent)) {
    return result('error', 'Could not parse Kiro usage output', null, null, 'parse')
  }
  return result(
    'ok',
    null,
    {
      usedPercent,
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      // Kiro supplies no exact reset time or zone, so keep its text as display metadata.
      resetsAt: null,
      resetDescription
    },
    header[2].trim()
  )
}

export async function fetchKiroRateLimits(
  options: { signal?: AbortSignal; runner?: CommandRunner; command?: string } = {}
): Promise<ProviderRateLimits> {
  try {
    const { stdout, stderr } = await (options.runner ?? runCommand)(
      options.command ?? resolveKiroCommand(),
      ['chat', '/usage', '--no-interactive', '--wrap', 'never'],
      options.signal
    )
    return parseKiroUsageOutput(`${stdout}\n${stderr}`)
  } catch (error) {
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null
    const unavailable = code === 'ENOENT'
    return result(
      unavailable ? 'unavailable' : 'error',
      unavailable ? 'Kiro CLI is not installed' : 'Kiro usage command failed',
      null,
      null,
      unavailable ? 'cli-unavailable' : 'usage-unavailable'
    )
  }
}
