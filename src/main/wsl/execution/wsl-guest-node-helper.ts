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
    throw new Error(`WSL ${distro}: ${describeWslProcessFailure(result)}`)
  }
  return result.stdout.trim()
}

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
