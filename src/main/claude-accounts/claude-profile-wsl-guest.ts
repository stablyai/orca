import { existsSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { WSL_CLAUDE_PROFILE_HELPER_FILENAME } from '../../shared/remote-bundle-artifacts'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import { ensureWslPinnedRuntime } from '../wsl/execution/wsl-pinned-runtime'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { runWslProcess, type WslSpec } from '../wsl/execution/wsl-runner'
import { describeWslProcessFailure } from '../wsl/execution/wsl-process-failure'
import { claudeProfileMarkerPath, type ClaudeProfileDescriptor } from './claude-profile-paths'
import { readClaudeFolderLoginAsync, type ClaudeFolderLogin } from './claude-account-folder'

export type WslSetup = (distro: string, guestHome: string, accountId: string) => Promise<void>

/** Guest reads go over the share; guest writes run a process in the distro. */
export function guestLogin(distro: string, stateFile: string): Promise<ClaudeFolderLogin | null> {
  return readClaudeFolderLoginAsync(toWindowsWslPath(stateFile, distro))
}

// Read over the share to avoid spawning a guest process for stats.
export async function guestStat(distro: string, linuxPath: string) {
  return lstat(toWindowsWslPath(linuxPath, distro)).catch(() => null)
}

export async function hasMarker(
  distro: string,
  profile: ClaudeProfileDescriptor
): Promise<boolean> {
  return (await guestStat(distro, claudeProfileMarkerPath(profile)))?.isFile() ?? false
}

/** Read over the share first to avoid a guest process when the pointer is unchanged. */
export async function writePointer(distro: string, pointer: string, home: string): Promise<void> {
  // Bound share reads so startup publication can fall back to a guest write.
  const current = await Promise.race([
    readFile(toWindowsWslPath(pointer, distro), 'utf8').catch(() => null),
    new Promise<null>((resolve) => setTimeout(resolve, 2_000, null).unref())
  ])
  if (current === home) {
    return
  }
  await runGuest(distro, {
    script:
      'umask 077; mkdir -p -- "${1%/*}" && printf %s "$2" > "$1.tmp" && mv -f -- "$1.tmp" "$1"',
    args: [pointer, home],
    loginPath: 'none'
  })
}

export async function runGuest(distro: string, spec: WslSpec, timeoutMs = 15_000): Promise<string> {
  const result = await runWslProcess({ ...spec, distro, timeoutMs, maxOutputBytes: 256 * 1024 })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`WSL ${distro}: ${describeWslProcessFailure(result)}`)
  }
  return result.stdout.trim()
}

/** Run guest setup with the pinned Node runtime. */
export const runWslSetup: WslSetup = async (distro, home, accountId) => {
  const helper = relayBundleCandidates('wsl')
    .map((dir) => join(dir, WSL_CLAUDE_PROFILE_HELPER_FILENAME))
    .find(existsSync)
  if (!helper) {
    throw new Error('The bundled WSL Claude account helper is missing. Reinstall Orca.')
  }
  const run = (spec: WslSpec, timeoutMs?: number) => runGuest(distro, spec, timeoutMs)
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
  // Successful setup is silent; warnings produce a report and refusal exits nonzero.
  const report = await run(
    {
      program: '/usr/bin/env',
      args: ['-u', 'NODE_OPTIONS', node, guestHelper, home, distro, accountId],
      loginPath: 'none'
    },
    120_000
  )
  if (report) {
    console.warn('[claude-profile] WSL account setup was incomplete:', report)
  }
}
