import { win32 } from 'node:path'
import { findGitSubcommandIndex, isWslDirectGitReadCommand } from './wsl-direct-git-read-commands'

/** autocrlf normalizes CRLF; minimal stat avoids drvfs rehashes from Windows index metadata (Git >=2.25). */
export const WINDOWS_CHECKOUT_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.autocrlf=true',
  '-c',
  'core.checkStat=minimal'
]

/** Normalize staged bytes to LF without writing CRLF until checkout ownership is proven. */
export const UNPROVEN_CHECKOUT_WRITE_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.autocrlf=input'
]

// New WSL checkouts have guest gitdir pointers; writing CRLF would leave files permanently modified.
const OTHER_CHECKOUT_SUBCOMMANDS = new Set(['clone', 'worktree'])

export function writesAnotherCheckout(args: readonly string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(args)
  return subcommandIndex !== -1 && OTHER_CHECKOUT_SUBCOMMANDS.has(args[subcommandIndex])
}

export const LINE_ENDING_SAMPLE_LIMIT = 200
// Bound scanned entries too: few matching text files would otherwise traverse the entire drvfs tree.
export const LINE_ENDING_SCAN_LIMIT = 10 * LINE_ENDING_SAMPLE_LIMIT
// Smaller samples cannot establish checkout ownership.
export const LINE_ENDING_MIN_EVIDENCE = 5
// Re-cloning at the same path can change the answer.
export const WSL_WINDOWS_CHECKOUT_TTL_MS = 10 * 60_000
const CACHE_LIMIT = 256

export type HostAutocrlfAnswer = 'true' | 'other' | 'not-repo'
export type LineEndingSampleAnswer = 'windows' | 'not-windows' | 'inconclusive'

type Timed<T> = { value: T; at: number }
type CheckoutState = {
  host?: Timed<HostAutocrlfAnswer>
  sample?: Timed<LineEndingSampleAnswer> & { identity: string | null }
}

const states = new Map<string, CheckoutState>()

export function isWslWindowsCheckoutCandidate(
  cwd: string | undefined,
  wslDistro: string | undefined,
  platform: NodeJS.Platform = process.platform
): cwd is string {
  return platform === 'win32' && Boolean(wslDistro) && Boolean(cwd && /^[A-Za-z]:[/\\]/.test(cwd))
}

export function wslWindowsCheckoutKey(cwd: string, wslDistro: string): string {
  return `${wslDistro.toLowerCase()}\0${win32.resolve(cwd).toLowerCase()}`
}

export function getWslWindowsCheckoutState(key: string): Readonly<CheckoutState> | undefined {
  return states.get(key)
}

function updateState(key: string, patch: CheckoutState): void {
  const next = { ...states.get(key), ...patch }
  states.delete(key)
  if (states.size >= CACHE_LIMIT) {
    const oldest = states.keys().next().value
    if (oldest !== undefined) {
      states.delete(oldest)
    }
  }
  states.set(key, next)
}

export function recordHostAutocrlf(key: string, value: HostAutocrlfAnswer, now: number): void {
  updateState(key, { host: { value, at: now } })
}

export function recordLineEndingSample(
  key: string,
  value: LineEndingSampleAnswer,
  identity: string | null,
  now: number
): void {
  updateState(key, { sample: { value, at: now, identity } })
}

export function forgetLineEndingSample(key: string): void {
  const state = states.get(key)
  if (state?.sample) {
    states.set(key, { ...state, sample: undefined })
  }
}

export function isFresh(entry: { at: number } | undefined, now: number): boolean {
  return entry !== undefined && now - entry.at < WSL_WINDOWS_CHECKOUT_TTL_MS
}

/** Last autocrlf value wins; true forces CRLF regardless of core.eol. */
export function parseHostAutocrlf(showOriginOutput: string): 'true' | 'other' {
  let value: string | null = null
  for (const line of showOriginOutput.split(/\r?\n/)) {
    const match = /\tcore\.autocrlf(?:\s+(.*))?$/i.exec(line)
    if (match) {
      value = (match[1] ?? 'true').trim().toLowerCase()
    }
  }
  return value !== null && ['true', 'yes', 'on', '1'].includes(value) ? 'true' : 'other'
}

/** Sample nested index entries: root files may be formatted as LF or have pinned eol attributes. */
export function classifyLineEndingSample(
  output: string,
  outputTruncated: boolean
): LineEndingSampleAnswer {
  const lines = output.split('\n').filter((line) => line.length > 0)
  if (outputTruncated || lines.length > LINE_ENDING_SAMPLE_LIMIT) {
    return 'inconclusive'
  }
  let crlf = 0
  let lf = 0
  for (const line of lines) {
    const match = /^i\/(\S*)\s+w\/(\S*)\s+attr\/([^\t]*)\t/.exec(line)
    if (!match || match[1] !== 'lf' || match[3].trim() !== '') {
      continue
    }
    if (match[2] === 'crlf') {
      crlf += 1
    } else if (match[2] === 'lf') {
      lf += 1
    }
  }
  if (crlf + lf < LINE_ENDING_MIN_EVIDENCE) {
    return 'inconclusive'
  }
  return crlf * 2 > crlf + lf ? 'windows' : 'not-windows'
}

/** Reads can use host autocrlf immediately; writes need fresh CRLF evidence before changing checkout bytes. */
export function windowsCheckoutGitConfigArgs(
  args: readonly string[],
  state: Readonly<CheckoutState> | undefined,
  now: number
): readonly string[] {
  if (state?.host?.value !== 'true' || state.sample?.value === 'not-windows') {
    return []
  }
  if (isWslDirectGitReadCommand(args)) {
    return WINDOWS_CHECKOUT_GIT_CONFIG_ARGS
  }
  if (writesAnotherCheckout(args)) {
    return []
  }
  return state.sample?.value === 'windows' && isFresh(state.sample, now)
    ? WINDOWS_CHECKOUT_GIT_CONFIG_ARGS
    : UNPROVEN_CHECKOUT_WRITE_GIT_CONFIG_ARGS
}

export function usesWindowsCheckoutGitConfig(
  args: readonly string[],
  state: Readonly<CheckoutState> | undefined,
  now: number
): boolean {
  return windowsCheckoutGitConfigArgs(args, state, now) === WINDOWS_CHECKOUT_GIT_CONFIG_ARGS
}

export function withWslWindowsCheckoutGitConfig(
  args: string[],
  cwd: string | undefined,
  wslDistro: string | undefined,
  platform: NodeJS.Platform = process.platform,
  now: number = Date.now()
): string[] {
  if (!isWslWindowsCheckoutCandidate(cwd, wslDistro, platform) || !wslDistro) {
    return args
  }
  const config = windowsCheckoutGitConfigArgs(
    args,
    states.get(wslWindowsCheckoutKey(cwd, wslDistro)),
    now
  )
  return config.length > 0 ? [...config, ...args] : args
}

export function resetWslWindowsCheckoutGitConfigForTests(): void {
  states.clear()
}
