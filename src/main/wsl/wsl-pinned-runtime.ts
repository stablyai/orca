import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { materializeNodeRuntimeArchive } from '../ssh/pinned-runtime-materializer'
import { parseGlibcVersion, parseOrcadLinuxLibc } from '../ssh/orcad-deployment-target'
import {
  installNodeRuntimeFromHostArchiveCommand,
  nodeRuntimeStoreDir,
  posixNodeRuntimeExecutable,
  probeRemoteNodeRuntimeCommand,
  REMOTE_NODE_RUNTIME_READY
} from '../ssh/orcad-remote-node-runtime'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { assertRemoteNodeRuntimePromoted } from '../ssh/orcad-remote-node-runtime-report'
import { isGlibcBelow, PINNED_NODE_GLIBC_FLOOR } from '../ssh/ssh-relay-pinned-node'
import type { WslSpec } from './wsl-runner'

const downloads = new Map<string, Promise<string>>()
const DOWNLOAD_TIMEOUT_MS = 180_000
export type WslRuntimeCommand = (spec: WslSpec, timeoutMs?: number) => Promise<string>

/** Shared pinned archive and guest store; never substitutes a user-installed runtime. */
export async function ensureWslPinnedRuntime(
  run: WslRuntimeCommand,
  cacheRoot: string,
  signal: AbortSignal,
  /** Names the caller in the architecture refusal, e.g. "SQLite reader". */
  purpose: string
): Promise<{ executable: string; home: string }> {
  const arch = await run({ program: 'uname', args: ['-m'], loginPath: 'none' })
  if (arch !== 'x86_64' && arch !== 'aarch64' && arch !== 'arm64') {
    throw new Error(`Unsupported WSL ${purpose} architecture: ${arch}`)
  }
  const libcProbe = await run({
    script:
      'getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 || ' +
      'for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done',
    loginPath: 'none'
  })
  const libc = parseOrcadLinuxLibc(libcProbe)
  const glibc = libc === 'glibc' ? parseGlibcVersion(libcProbe) : null
  let target: NodeRuntimeTarget = `linux-${arch === 'x86_64' ? 'x64' : 'arm64'}-${libc}`
  if (glibc && isGlibcBelow(glibc, PINNED_NODE_GLIBC_FLOOR)) {
    if (arch === 'x86_64' && !isGlibcBelow(glibc, { major: 2, minor: 17 })) {
      target = 'linux-x64-glibc217'
    } else {
      throw new Error(
        `This WSL distro's glibc ${glibc.major}.${glibc.minor} is too old for Orca's pinned runtime.`
      )
    }
  }
  const home = await run({ script: 'printf %s "$HOME"', loginPath: 'none' })
  if (!home.startsWith('/') || /[\r\n\0]/.test(home)) {
    throw new Error('WSL did not provide an absolute home directory.')
  }
  const host = getRemoteHostPlatform(arch === 'x86_64' ? 'linux-x64' : 'linux-arm64')
  const runtimeDir = nodeRuntimeStoreDir(host, `${home}/.cache/orca`, target)
  const executable = posixNodeRuntimeExecutable(host, runtimeDir)
  const probe = await run({
    script: probeRemoteNodeRuntimeCommand(host, runtimeDir, target),
    loginPath: 'none'
  })
  if (probe !== REMOTE_NODE_RUNTIME_READY) {
    let download = downloads.get(`${cacheRoot}:${target}`)
    if (!download) {
      // Why its own deadline: a joining caller's abort must not cancel another caller's download.
      download = materializeNodeRuntimeArchive(target, cacheRoot, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          // Why a checksum mismatch passes as is: its own text already names the runtime archive.
          throw /checksum mismatch/.test(message)
            ? error
            : new Error(`Could not download Orca's Node runtime for WSL: ${message}`, {
                cause: error
              })
        })
        .finally(() => downloads.delete(`${cacheRoot}:${target}`))
      downloads.set(`${cacheRoot}:${target}`, download)
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
    // Why classified: the loader's own words (missing libstdc++, security software) reach the user.
    assertRemoteNodeRuntimePromoted(promoted)
  }
  return { executable, home }
}
