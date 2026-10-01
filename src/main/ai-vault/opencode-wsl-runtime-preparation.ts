import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { ServerTarget } from '../../shared/node-runtime-pin'
import { RELAY_OPENCODE_SQLITE_READER_FILENAME } from '../../shared/relay-artifacts'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { NODE_SQLITE_READER_API_SOURCE } from '../sqlite/node-sqlite-reader-api'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { materializeNodeRuntimeArchive } from '../ssh/pinned-runtime-materializer'
import { parseOrcadLinuxLibc } from '../ssh/orcad-deployment-target'
import {
  installNodeRuntimeFromHostArchiveCommand,
  nodeRuntimeStoreDir,
  posixNodeRuntimeExecutable,
  probeRemoteNodeRuntimeCommand,
  REMOTE_NODE_RUNTIME_READY
} from '../ssh/orcad-remote-node-runtime'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { runWslProcess, type WslSpec } from '../wsl/wsl-runner'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import type { OpenCodeWslRuntime } from './session-scanner-opencode-wsl-runtime'

const preparation = new Map<string, { value: OpenCodeWslRuntime; expires: number }>()
const downloads = new Map<ServerTarget, Promise<string>>()
const PREPARATION_TIMEOUT_MS = 180_000
const SQLITE_PROBE = `const sqlite=require('node:sqlite');if(!(${NODE_SQLITE_READER_API_SOURCE})(sqlite))throw Error('SQLite reader API missing');const db=new sqlite.DatabaseSync(':memory:');db.prepare('SELECT 1').get();db.close();process.stdout.write(process.execPath)`

/** Only running distro roots enter here; a slow first install must not hold up local history. */
export async function prepareOpenCodeWslReaders(
  roots: readonly string[]
): Promise<OpenCodeWslRuntime[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const distros = new Map<string, string>()
  for (const root of roots) {
    const distro = parseWslUncPath(root)?.distro
    if (distro) {
      distros.set(distro.toLowerCase(), distro)
    }
  }
  for (const [key, entry] of preparation) {
    if (!distros.has(key) && Number.isFinite(entry.expires)) {
      preparation.delete(key)
    }
  }
  return [...distros].map(([key, distro]) => {
    const previous = preparation.get(key)
    if (previous && previous.expires > Date.now()) {
      return previous.value
    }
    const entry: { expires: number; value: OpenCodeWslRuntime } = {
      expires: Number.POSITIVE_INFINITY,
      value: previous?.value.executable
        ? previous.value
        : {
            distro,
            error: 'Preparing the WSL SQLite reader. Refresh Vault after setup finishes.'
          }
    }
    preparation.set(key, entry)
    void prepare(distro).then(
      (runtime) => {
        entry.expires = Date.now() + (runtime.executable ? 10 * 60_000 : 30_000)
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
  const run = async (spec: WslSpec, timeoutMs = 15_000): Promise<string> => {
    signal.throwIfAborted()
    const running = await waitForPromiseWithSignal(
      filterPathsToRunningWslDistrosAsync([toWindowsWslUncPath('/', distro)], {
        requireConfirmed: true
      }),
      signal
    )
    if (running.length === 0) {
      throw new Error(`WSL distro ${distro} is not running. Start it to read its history.`)
    }
    signal.throwIfAborted()
    const result = await runWslProcess({
      ...spec,
      distro,
      timeoutMs: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
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
  const hasDatabase = await run({
    script: [
      'data="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"',
      // WSL discovery still enumerates the default data root independently of guest overrides.
      'for db in "$HOME/.local/share/opencode"/opencode.db "$HOME/.local/share/opencode"/opencode-*.db; do if [ -f "$db" ]; then printf present; exit 0; fi; done',
      'case "${OPENCODE_DB-}" in',
      '  :memory:) exit 0 ;;',
      '  /*) [ ! -f "$OPENCODE_DB" ] || printf present ;;',
      '  "") for db in "$data"/opencode*.db; do if [ -f "$db" ]; then printf present; break; fi; done ;;',
      '  *) [ ! -f "$data/$OPENCODE_DB" ] || printf present ;;',
      'esac'
    ].join('\n'),
    loginPath: 'none'
  })
  if (hasDatabase !== 'present') {
    return { distro, error: 'No OpenCode database is present in this WSL distro.' }
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
    const home = await run({ script: 'printf %s "$HOME"', loginPath: 'none' })
    if (!home.startsWith('/')) {
      throw new Error('WSL did not provide an absolute home directory.')
    }
    // Same layout and checks as an SSH host's store; a legacy vault-sqlite/ Bun is left alone.
    const host = getRemoteHostPlatform(arch === 'x86_64' ? 'linux-x64' : 'linux-arm64')
    const runtimeDir = nodeRuntimeStoreDir(host, `${home}/.cache/orca`, target)
    executable = posixNodeRuntimeExecutable(host, runtimeDir)
    const probe = await run({
      script: probeRemoteNodeRuntimeCommand(host, runtimeDir, target),
      loginPath: 'none'
    })
    if (probe !== REMOTE_NODE_RUNTIME_READY) {
      let download = downloads.get(target)
      if (!download) {
        download = materializeNodeRuntimeArchive(
          target,
          join(app.getPath('userData'), 'orcad-artifacts'),
          { signal: AbortSignal.timeout(PREPARATION_TIMEOUT_MS) }
        ).finally(() => downloads.delete(target))
        downloads.set(target, download)
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
      if (promoted.split('\n').at(-1) !== REMOTE_NODE_RUNTIME_READY) {
        throw new Error('WSL did not verify the pinned Node runtime.')
      }
    }
  }
  return { distro, executable, readerPath }
}
