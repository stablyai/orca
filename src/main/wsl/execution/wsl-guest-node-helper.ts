import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { ensureWslPinnedRuntime } from './wsl-pinned-runtime'
import { relayBundleCandidates } from './relay-bundle-paths'
import { describeWslProcessFailure } from './wsl-process-failure'
import { runWslProcess, type WslSpec } from './wsl-runner'

async function runGuest(
  distro: string,
  spec: WslSpec,
  timeoutMs = 15_000,
  maxOutputBytes = 256 * 1024
): Promise<string> {
  const result = await runWslProcess({ ...spec, distro, timeoutMs, maxOutputBytes })
  if (result.code !== 0 || result.timedOut) {
    throw new WslGuestRunError(`WSL ${distro}: ${describeWslProcessFailure(result)}`, result.code)
  }
  return result.stdout.trim()
}

/** A guest command that ran and failed, as opposed to a distro that was stopped before it ran. */
class WslGuestRunError extends Error {
  readonly code: number | null
  constructor(message: string, code: number | null) {
    super(message)
    this.code = code
  }
}

// `env` exits 127 when the cached pinned Node is gone (its cache cleared, or on tmpfs).
const COMMAND_NOT_FOUND_EXIT_CODE = 127

async function findBundledHelper(filename: string): Promise<string | null> {
  for (const directory of relayBundleCandidates('wsl')) {
    const candidate = join(directory, filename)
    if (
      await access(candidate).then(
        () => true,
        () => false
      )
    ) {
      return candidate
    }
  }
  return null
}

// Per distro: the pinned Node and each helper's guest path, so a warm run is one wsl.exe, not six.
const resolvedGuests = new Map<string, { node: string; helpers: Map<string, string> }>()

/** Runs a bundled guest helper on Orca's pinned Node inside the distro; returns its stdout. */
export async function runWslGuestNodeHelper(args: {
  distro: string
  helperFilename: string
  /** Names the helper in the error when the bundle lacks it. */
  helperLabel: string
  helperArgs: readonly string[]
  timeoutMs: number
  maxOutputBytes?: number
  /** Throws once the distro stopped; `wsl -d` would boot it again. */
  requireRunning?: () => Promise<void>
}): Promise<string> {
  const helper = await findBundledHelper(args.helperFilename)
  if (!helper) {
    throw new Error(`The bundled WSL ${args.helperLabel} helper is missing. Reinstall Orca.`)
  }
  const requireRunning = args.requireRunning ?? (async () => {})
  const run = async (spec: WslSpec, timeoutMs?: number) => {
    await requireRunning()
    return runGuest(args.distro, spec, timeoutMs)
  }
  const key = args.distro.toLowerCase()
  const runHelper = async (node: string, guestHelper: string): Promise<string> => {
    await requireRunning()
    return runGuest(
      args.distro,
      {
        program: '/usr/bin/env',
        args: ['-u', 'NODE_OPTIONS', node, guestHelper, ...args.helperArgs],
        loginPath: 'none'
      },
      args.timeoutMs,
      args.maxOutputBytes
    )
  }
  const cached = resolvedGuests.get(key)
  const cachedHelper = cached?.helpers.get(helper)
  if (cached && cachedHelper) {
    try {
      return await runHelper(cached.node, cachedHelper)
    } catch (error) {
      // A stopped distro keeps the cache; a helper that failed on its own isn't rerun (that would
      // double a long helper's timeout), but a missing runtime is reinstalled below, once.
      if (!(error instanceof WslGuestRunError)) {
        throw error
      }
      resolvedGuests.delete(key)
      if (error.code !== COMMAND_NOT_FOUND_EXIT_CODE) {
        throw error
      }
    }
  }
  const node = await ensureWslPinnedRuntime(
    run,
    join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
    AbortSignal.timeout(180_000)
  )
  const guestHelper = await run({
    program: 'wslpath',
    args: ['-a', '-u', helper],
    loginPath: 'none'
  })
  const entry = resolvedGuests.get(key)
  const resolved = entry?.node === node ? entry : { node, helpers: new Map<string, string>() }
  resolved.helpers.set(helper, guestHelper)
  resolvedGuests.set(key, resolved)
  try {
    return await runHelper(node, guestHelper)
  } catch (error) {
    if (error instanceof WslGuestRunError) {
      resolvedGuests.delete(key)
    }
    throw error
  }
}
