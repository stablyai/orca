import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { materializeNodeRuntimeArchive } from '../node-runtime/pinned-runtime-materializer'
import { probeLinuxLibc } from '../node-runtime/linux-libc-probe'
import {
  installNodeRuntimeFromHostArchiveCommand,
  nodeRuntimeStoreDir,
  posixNodeRuntimeExecutable,
  probeRemoteNodeRuntimeCommand
} from '../managed-server/install/orcad-remote-node-runtime'
import {
  REMOTE_NODE_RUNTIME_READY,
  assertRemoteNodeRuntimePromoted
} from '../ssh/orcad-remote-node-runtime-report'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { isGlibcBelow, PINNED_NODE_GLIBC_FLOOR } from '../ssh/pinned-runtime-host-target'
import type { WslSpec } from './wsl-runner'

const downloads = new Map<string, Promise<string>>()
const DOWNLOAD_TIMEOUT_MS = 180_000
/** Runs one command in the distro and returns its trimmed stdout; throws on failure. */
export type WslRuntimeCommand = (spec: WslSpec, timeoutMs?: number) => Promise<string>

/** Use the shared guest-store pinned Node, installed from host archive cache on first use; never substitute user runtimes. */
export async function ensureWslPinnedRuntime(
  run: WslRuntimeCommand,
  cacheRoot: string,
  signal: AbortSignal
): Promise<string> {
  const arch = await run({ program: 'uname', args: ['-m'], loginPath: 'none' })
  if (arch !== 'x86_64' && arch !== 'aarch64' && arch !== 'arm64') {
    throw new Error(`Unsupported WSL architecture: ${arch}`)
  }
  const { libc, glibc } = await probeLinuxLibc((script) => run({ script, loginPath: 'none' }))
  // Reject unsupported glibc before downloading a pinned Node that cannot load.
  if (glibc && isGlibcBelow(glibc, PINNED_NODE_GLIBC_FLOOR)) {
    throw new Error(
      `This WSL distro's glibc ${glibc.major}.${glibc.minor} is older than ` +
        `${PINNED_NODE_GLIBC_FLOOR.major}.${PINNED_NODE_GLIBC_FLOOR.minor}, which Orca's Node runtime needs.`
    )
  }
  const target = `linux-${arch === 'x86_64' ? 'x64' : 'arm64'}-${libc}` as const
  const home = await run({ script: 'printf %s "$HOME"', loginPath: 'none' })
  if (!home.startsWith('/')) {
    throw new Error('WSL did not provide an absolute home directory.')
  }
  const host = getRemoteHostPlatform(arch === 'x86_64' ? 'linux-x64' : 'linux-arm64')
  const runtimeDir = nodeRuntimeStoreDir(host, `${home}/.cache/orca`, target)
  const executable = posixNodeRuntimeExecutable(host, runtimeDir)
  const probe = await run({
    script: probeRemoteNodeRuntimeCommand(host, runtimeDir, target),
    loginPath: 'none'
  })
  if (probe === REMOTE_NODE_RUNTIME_READY) {
    return executable
  }
  const key = `${cacheRoot}:${target}`
  let download = downloads.get(key)
  if (!download) {
    // Use an independent download deadline so one joining caller cannot abort everyone's download.
    download = materializeNodeRuntimeArchive(target, cacheRoot, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    }).finally(() => downloads.delete(key))
    downloads.set(key, download)
  }
  const localArchive = await waitForPromiseWithSignal(download, signal)
  const source = await run({
    program: 'wslpath',
    args: ['-a', '-u', localArchive],
    loginPath: 'none'
  })
  const promoted = await run(
    {
      script: installNodeRuntimeFromHostArchiveCommand(host, {
        runtimeDir,
        archive: basename(localArchive),
        target,
        token: randomBytes(8).toString('hex')
      }),
      args: [source],
      loginPath: 'none'
    },
    120_000
  )
  assertRemoteNodeRuntimePromoted(promoted)
  return executable
}
