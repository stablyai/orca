import { createRunningWslRuntimeRunner, ensureWslBunRuntime } from '../wsl/wsl-bun-runtime'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { RELAY_OPENCODE_SQLITE_READER_FILENAME } from '../../shared/relay-artifacts'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import type { OpenCodeWslRuntime } from './session-scanner-opencode-wsl-runtime'

const preparation = new Map<string, { value: OpenCodeWslRuntime; expires: number }>()

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
  const execution = createRunningWslRuntimeRunner(distro)
  const { run } = execution
  const app = getAppEnvironment()
  // The reader is plain JavaScript; either packaged Linux architecture is usable.
  const reader = [
    join(app.getAppPath(), 'session-scanner-opencode-sqlite-process-entry.js'),
    ...(['linux-x64', 'linux-arm64'] as const)
      .flatMap((platform) => relayBundleCandidates(platform, app.getAppPath()))
      .map((directory) => join(directory, RELAY_OPENCODE_SQLITE_READER_FILENAME))
  ].find(existsSync)
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
  const executable = await ensureWslBunRuntime(execution)
  return { distro, executable, readerPath }
}
