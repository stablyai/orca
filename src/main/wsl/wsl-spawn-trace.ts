/**
 * Diagnostics only, off unless ORCA_WSL_SPAWN_TRACE=1: one main-log line per wsl.exe start and per
 * E9 gate verdict, with a few caller frames, to name what starts a stopped distro (E9).
 */
import { win32 } from 'node:path'
import { isWslUserActFor } from './wsl-user-act-scope'

export const WSL_SPAWN_TRACE_ENV = 'ORCA_WSL_SPAWN_TRACE'
const MAX_ARG_CHARS = 160
const MAX_FRAMES = 12

export function isWslSpawnTraceEnabled(): boolean {
  return process.env[WSL_SPAWN_TRACE_ENV] === '1'
}

/** A wsl.exe start (or a resolved WSL Git/CLI command): its argv and who asked for it. */
export function traceWslSpawn(source: string, command: string, args: readonly string[]): void {
  if (!isWslSpawnTraceEnabled() || !isWslExecutable(command, source)) {
    return
  }
  const distro = distroArg(args)
  writeTrace(
    `spawn ${source}`,
    `distro=${distro ?? '-'} userAct=${distro ? isWslUserActFor(distro) : false} argv=${formatArgs(args)}`,
    traceWslSpawn
  )
}

/** An E9 gate's answer for a distro, and how it got it (a user act, or the running list). */
export function traceWslGate(gate: string, distro: string, verdict: string): void {
  if (!isWslSpawnTraceEnabled()) {
    return
  }
  writeTrace(`gate ${gate}`, `distro=${distro} verdict=${verdict}`, traceWslGate)
}

function isWslExecutable(command: string, source: string): boolean {
  // The Git runner traces its resolved command before choosing a spawn API; it always names wsl.exe.
  return source === 'git-runner' || win32.basename(command).toLowerCase() === 'wsl.exe'
}

function distroArg(args: readonly string[]): string | null {
  const index = args.findIndex((arg) => arg === '-d' || arg === '--distribution')
  return index !== -1 ? (args[index + 1] ?? null) : null
}

function formatArgs(args: readonly string[]): string {
  return JSON.stringify(
    args.map((arg) => (arg.length > MAX_ARG_CHARS ? `${arg.slice(0, MAX_ARG_CHARS)}…` : arg))
  )
}

function writeTrace(kind: string, detail: string, entry: (...args: never[]) => void): void {
  try {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = MAX_FRAMES + 6
    // Frames start at the traced call's caller, so bundling cannot hide the trace helpers' names.
    const holder: { stack?: string } = {}
    Error.captureStackTrace(holder, entry)
    Error.stackTraceLimit = limit
    const frames = (holder.stack ?? '')
      .split('\n')
      .slice(1)
      .map((line) => line.trim().replace(/^at /, ''))
      // Spawn-observer plumbing names nothing about the caller.
      .filter((line) => !/notifySpawnObserver|spawn-observer|run-process\.js|^node:/.test(line))
      .slice(0, MAX_FRAMES)
    console.warn(`[wsl-spawn-trace] ${kind} ${detail} at ${frames.join(' < ')}`)
  } catch {
    // Diagnostics must never fail the work they describe.
  }
}
