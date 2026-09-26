import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { ORCAD_BUN_RELEASE_ASSETS, type OrcadBunTarget } from '../../shared/orcad-bun-runtime'
import { RELAY_OPENCODE_SQLITE_READER_FILENAME } from '../../shared/relay-artifacts'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { materializeCachedOrcadBunRuntime } from '../ssh/orcad-bun-runtime-materializer'
import { parseOrcadLinuxLibc } from '../ssh/orcad-deployment-target'
import { runWslProcess, type WslSpec } from '../wsl/wsl-runner'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import type { OpenCodeWslRuntime } from './session-scanner-opencode-wsl-runtime'

const preparation = new Map<string, { value: OpenCodeWslRuntime; expires: number }>()
const downloads = new Map<OrcadBunTarget, Promise<string>>()
const PREPARATION_TIMEOUT_MS = 180_000
const SQLITE_PROBE = `const db=new (require('node:sqlite').DatabaseSync)(':memory:');db.prepare('SELECT 1').get();db.close();process.stdout.write(process.execPath)`

/** Only running distro roots enter here; a slow first install must not hold up local history. */
export async function prepareOpenCodeWslReaders(
  roots: readonly string[]
): Promise<OpenCodeWslRuntime[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const distros = new Map(
    roots.flatMap((root) => {
      const distro = parseWslUncPath(root)?.distro
      return distro ? [[distro.toLowerCase(), distro] as const] : []
    })
  )
  return [...distros].map(([key, distro]) => {
    const previous = preparation.get(key)
    if (previous && previous.expires > Date.now()) {
      return previous.value
    }
    const entry: { expires: number; value: OpenCodeWslRuntime } = {
      expires: Number.POSITIVE_INFINITY,
      value: {
        distro,
        error: 'Preparing the WSL SQLite reader. Refresh Vault after setup finishes.'
      }
    }
    preparation.set(key, entry)
    void prepare(distro).then(
      (runtime) => {
        entry.expires = Date.now() + 10 * 60_000
        entry.value = runtime
      },
      (error: unknown) => {
        entry.expires = Date.now() + 30_000
        entry.value = { distro, error: error instanceof Error ? error.message : String(error) }
      }
    )
    return entry.value
  })
}

async function prepare(distro: string): Promise<OpenCodeWslRuntime> {
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS
  const signal = AbortSignal.timeout(PREPARATION_TIMEOUT_MS)
  const run = async (spec: WslSpec): Promise<string> => {
    signal.throwIfAborted()
    const running = await waitForPromiseWithSignal(
      filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)]),
      signal
    )
    if (running.length === 0) {
      throw new Error(`WSL distro ${distro} is not running. Start it to read its history.`)
    }
    signal.throwIfAborted()
    const result = await runWslProcess({
      ...spec,
      distro,
      timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())),
      maxOutputBytes: 16 * 1024
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`WSL SQLite reader setup failed: ${result.stderr.trim() || 'command failed'}`)
    }
    return result.stdout.trim()
  }
  const app = getAppEnvironment()
  // The reader is plain JavaScript; either packaged Linux architecture is usable.
  const reader = (['linux-x64', 'linux-arm64'] as const)
    .flatMap((platform) => relayBundleCandidates(platform, app.getAppPath()))
    .map((directory) => join(directory, RELAY_OPENCODE_SQLITE_READER_FILENAME))
    .find(existsSync)
  if (!reader) {
    throw new Error('The bundled WSL SQLite reader is missing. Reinstall Orca to repair it.')
  }
  const readerPath = await run({
    program: 'wslpath',
    args: ['-a', '-u', reader],
    loginPath: 'none'
  })
  let executable: string | null = null
  try {
    executable = await run({ program: 'node', args: ['-e', SQLITE_PROBE], loginPath: 'preferred' })
  } catch {
    // Older guest Node remains supported; only the SQLite reader needs this runtime.
  }
  if (!executable?.startsWith('/')) {
    const arch = await run({ program: 'uname', args: ['-m'], loginPath: 'none' })
    if (arch !== 'x86_64' && arch !== 'aarch64' && arch !== 'arm64') {
      throw new Error(`Unsupported WSL SQLite reader architecture: ${arch}`)
    }
    const libc = parseOrcadLinuxLibc(
      await run({
        script:
          'getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 || ' +
          'for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done',
        loginPath: 'none'
      })
    )
    const target = `linux-${arch === 'x86_64' ? 'x64' : 'arm64'}-${libc}` as const
    const expected = ORCAD_BUN_RELEASE_ASSETS[target].executableSha256
    const home = await run({ script: 'printf %s "$HOME"', loginPath: 'none' })
    if (!home.startsWith('/')) {
      throw new Error('WSL did not provide an absolute home directory.')
    }
    executable = `${home}/.cache/orca/vault-sqlite/${expected}/bun`
    const present = await run({
      script: 'if [ -x "$1" ]; then sha256sum -- "$1"; fi',
      args: [executable],
      loginPath: 'none'
    })
    if (!present.startsWith(`${expected} `)) {
      let download = downloads.get(target)
      if (!download) {
        download = materializeCachedOrcadBunRuntime(
          target,
          join(app.getPath('userData'), 'orcad-artifacts'),
          {
            signal: AbortSignal.timeout(PREPARATION_TIMEOUT_MS)
          }
        ).finally(() => downloads.delete(target))
        downloads.set(target, download)
      }
      const localRuntime = await waitForPromiseWithSignal(download, signal)
      const source = await run({
        program: 'wslpath',
        args: ['-a', '-u', localRuntime],
        loginPath: 'none'
      })
      await run({
        script: [
          'set -eu; umask 077',
          'mkdir -p -- "${2%/*}"',
          'stage=$(mktemp "${2}.upload.XXXXXX")',
          'trap \'rm -f -- "$stage"\' EXIT',
          'cp -- "$1" "$stage"',
          'actual=$(sha256sum -- "$stage"); [ "${actual%% *}" = "$3" ]',
          'chmod 700 "$stage"',
          'mv -f -- "$stage" "$2"'
        ].join('\n'),
        args: [source, executable, expected],
        loginPath: 'none'
      })
    }
  }
  return { distro, executable, readerPath }
}
