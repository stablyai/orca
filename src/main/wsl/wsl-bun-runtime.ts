import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { ORCAD_BUN_RELEASE_ASSETS, type OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { materializeCachedOrcadBunRuntime } from '../ssh/orcad-bun-runtime-materializer'
import { parseOrcadLinuxLibc } from '../ssh/orcad-deployment-target'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { shellEscape } from '../ssh/ssh-connection-utils'
import {
  parseRelayBunRuntimeResult,
  probeRelayBunRuntimeCommand,
  promoteRelayBunRuntimeCommand
} from '../ssh/ssh-relay-bun-runtime-commands'
import { runWslProcess, type WslSpec } from './wsl-runner'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'

const PREPARATION_TIMEOUT_MS = 180_000
const downloads = new Map<OrcadBunTarget, Promise<string>>()

export async function assertWslRuntimeDistroRunning(
  distro: string,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const running = await waitForPromiseWithSignal(
    filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)], {
      requireConfirmed: true
    }),
    signal
  )
  if (running.length === 0) {
    throw new Error(`WSL distro ${distro} is not running. Start it to prepare its runtime.`)
  }
  signal.throwIfAborted()
}

/** Refuse guest commands without a confirmed running verdict; WSL has no atomic check-and-exec. */
export function createRunningWslRuntimeRunner(
  distro: string,
  callerSignal?: AbortSignal,
  user?: string
): {
  run: (spec: WslSpec) => Promise<string>
  signal: AbortSignal
} {
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS
  const timeout = AbortSignal.timeout(PREPARATION_TIMEOUT_MS)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
  const run = async (spec: WslSpec): Promise<string> => {
    await assertWslRuntimeDistroRunning(distro, signal)
    const result = await runWslProcess({
      ...spec,
      distro,
      ...(user ? { user } : {}),
      timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())),
      maxOutputBytes: 16 * 1024
    })
    signal.throwIfAborted()
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`WSL runtime setup failed: ${result.stderr.trim() || 'command failed'}`)
    }
    return result.stdout.trim()
  }
  return { run, signal }
}

export async function ensureWslBunRuntime(
  execution: ReturnType<typeof createRunningWslRuntimeRunner>
): Promise<string> {
  const { run, signal } = execution
  const arch = await run({ program: 'uname', args: ['-m'], loginPath: 'none' })
  if (arch !== 'x86_64' && arch !== 'aarch64' && arch !== 'arm64') {
    throw new Error(`Unsupported WSL runtime architecture: ${arch}`)
  }
  const libc = parseOrcadLinuxLibc(
    await run({
      script:
        'getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 || ' +
        'for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done',
      loginPath: 'none'
    })
  )
  const platform = `linux-${arch === 'x86_64' ? 'x64' : 'arm64'}` as const
  const target = `${platform}-${libc}` as const
  const host = getRemoteHostPlatform(platform)
  const expectedHash = ORCAD_BUN_RELEASE_ASSETS[target].executableSha256
  const home = await run({ script: 'printf %s "$HOME"', loginPath: 'none' })
  if (!home.startsWith('/')) {
    throw new Error('WSL did not provide an absolute home directory.')
  }
  const directory = `${home}/.cache/orca/runtimes/${expectedHash}`
  const executable = `${directory}/bun`
  const cached = parseRelayBunRuntimeResult(
    await run({
      script: probeRelayBunRuntimeCommand(host, executable, expectedHash),
      loginPath: 'none'
    })
  )
  if (cached) {
    return cached
  }
  let download = downloads.get(target)
  if (!download) {
    download = materializeCachedOrcadBunRuntime(
      target,
      join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
      { signal: AbortSignal.timeout(PREPARATION_TIMEOUT_MS) }
    ).finally(() => downloads.delete(target))
    downloads.set(target, download)
  }
  const localRuntime = await waitForPromiseWithSignal(download, signal)
  const source = await run({
    program: 'wslpath',
    args: ['-a', '-u', localRuntime],
    loginPath: 'none'
  })
  const token = randomBytes(12).toString('hex')
  const stage = `${directory}/upload-${token}`
  const uploaded = `${stage}/bun`
  const published = parseRelayBunRuntimeResult(
    await run({
      script: [
        'umask 077',
        `mkdir -p ${shellEscape(directory)} || exit 1`,
        `mkdir ${shellEscape(stage)} || exit 1`,
        `stage=${shellEscape(stage)}`,
        `trap 'rm -rf -- "$stage"' EXIT`,
        `cp -- ${shellEscape(source)} ${shellEscape(uploaded)} || exit 1`,
        promoteRelayBunRuntimeCommand({
          host,
          source: uploaded,
          executable,
          expectedHash,
          repairToken: token
        })
      ].join('\n'),
      loginPath: 'none'
    })
  )
  if (!published) {
    throw new Error('WSL did not publish the verified Bun runtime.')
  }
  return published
}
