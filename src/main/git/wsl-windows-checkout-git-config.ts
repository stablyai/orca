import { win32 } from 'node:path'
import { findGitSubcommandIndex, isWslDirectGitReadCommand } from './wsl-direct-git-read-commands'

/**
 * Per-command config that makes Linux Git read a Windows Git checkout the way Windows Git does.
 *
 * - core.autocrlf=true: CRLF working files compare equal to LF blobs, and staging writes LF;
 *   without it every rehashed file reads as modified and `add` commits CRLF.
 * - core.checkStat=minimal: an index Windows Git wrote carries no inode/uid/ctime Linux Git
 *   agrees with, so every entry otherwise rehashes across drvfs (~70 s on 11k files). It also
 *   skips the ctime check, so `core.trustctime` is moot here.
 *
 * Both predate the Git 2.25 baseline, so no capability probe is needed.
 */
export const WINDOWS_CHECKOUT_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.autocrlf=true',
  '-c',
  'core.checkStat=minimal'
]

/**
 * Writes while the sample has not proven which Git wrote the checkout: `input` stages LF like
 * Windows Git would, yet never writes CRLF into what may be a Linux checkout.
 */
export const UNPROVEN_CHECKOUT_WRITE_GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.autocrlf=input'
]

// Why: these write a new checkout whose `.git` points at /mnt/..., which Windows Git cannot open,
// so its probe answers not-repo and CRLF files written here would read as modified forever.
const OTHER_CHECKOUT_SUBCOMMANDS = new Set(['clone', 'worktree'])

export function writesAnotherCheckout(args: readonly string[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(args)
  return subcommandIndex !== -1 && OTHER_CHECKOUT_SUBCOMMANDS.has(args[subcommandIndex])
}

/** Deliberate cap: ~200 eligible files decide the checkout. */
export const LINE_ENDING_SAMPLE_LIMIT = 200
// Why: `ls-files --eol` reads every file it lists over drvfs, so capping matches alone still reads
// the whole tree when few files qualify (`* text=auto`); the scan stops after this many entries.
export const LINE_ENDING_SCAN_LIMIT = 10 * LINE_ENDING_SAMPLE_LIMIT
// Fewer eligible files than this is no evidence either way.
export const LINE_ENDING_MIN_EVIDENCE = 5
// Why a TTL: a re-clone at the same path can change the answer.
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

/**
 * Effective `core.autocrlf` from `git config --show-origin --get-regexp`, the way Windows Git
 * resolves it (last value wins). Only `true` makes Windows Git write CRLF.
 *
 * Why core.eol is ignored: with autocrlf=true Windows Git checks out CRLF regardless of core.eol
 * (measured: local core.eol=lf still leaves Windows Git and the flagged WSL Git both clean).
 */
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

/**
 * Classifies a bounded `ls-files --eol` sample of LF blobs with no eol attribute.
 *
 * The first index entries, not just top-level files: root files are the ones formatters re-save
 * as LF, the ones attributes pin, and absent in some repos. Majority of CRLF working files means Windows Git
 * (autocrlf=true) wrote this checkout; one CRLF README in a Linux checkout does not.
 */
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

/**
 * Whether this command runs with Windows Git's settings.
 *
 * Reads need only the host's autocrlf=true: the flags never make a read less correct, even on an
 * LF checkout, so an unfinished sample must not leave status flashing every file as modified.
 * Writes change bytes on disk or in the index, so they need a fresh sample proving CRLF; until then
 * they only normalize what they stage.
 */
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

/** Whether this command runs with Windows Git's full settings, including minimal stat. */
export function usesWindowsCheckoutGitConfig(
  args: readonly string[],
  state: Readonly<CheckoutState> | undefined,
  now: number
): boolean {
  return windowsCheckoutGitConfigArgs(args, state, now) === WINDOWS_CHECKOUT_GIT_CONFIG_ARGS
}

/** `args` with Windows Git's settings prepended when this WSL command needs them. */
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
