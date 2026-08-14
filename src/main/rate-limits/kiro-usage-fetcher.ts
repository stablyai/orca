import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { getSpawnArgsForWindows } from '../win32-utils'

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

function resolveKiroCommand(): string {
  const configured = process.env.KIRO_CLI_PATH?.trim()
  const candidates = [
    configured,
    join(homedir(), 'bin', 'kiro-cli'),
    join(homedir(), '.local', 'bin', 'kiro-cli')
  ]
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next known install location.
    }
  }
  return process.platform === 'win32' ? 'kiro-cli.exe' : 'kiro-cli'
}

const runCommand: CommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    // Why: execFile cannot launch configured .cmd/.bat shims directly on
    // Windows; route them through cmd.exe like the other usage fetchers.
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
    execFile(
      spawnCmd,
      spawnArgs,
      { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      }
    )
  })

export function parseKiroUsageOutput(output: string): ProviderRateLimits {
  const readable = stripAnsiEscapeSequences(output).replace(/\r/g, '')
  const header = readable.match(
    /Estimated Usage\s*\|\s*resets on (\d{4}-\d{2}-\d{2})\s*\|\s*([^\n]+)/i
  )
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
  if (!header || usedPercent === null || !Number.isFinite(usedPercent)) {
    return result('error', 'Could not parse Kiro usage output', null, null, 'parse')
  }
  return result(
    'ok',
    null,
    {
      usedPercent,
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      // Kiro reports a calendar date without a time zone or time of day. Keep it as
      // display metadata instead of inventing a UTC-midnight countdown.
      resetsAt: null,
      resetDescription: header[1]
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
    const code = (error as NodeJS.ErrnoException | null)?.code
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
