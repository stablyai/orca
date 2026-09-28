/**
 * The PATH entry through which an Orca-launched child reaches THIS app's own CLI.
 *
 * Extracted from `buildPtyHostEnv` so the structured-session lane can apply the identical
 * treatment. A structured worker has no PTY, but its provider child runs `orca orchestration ...`
 * exactly like a PTY worker's agent does, and it was inheriting the ambient PATH instead. On
 * packaged Linux that made bare `orca` resolve to GNOME's /usr/bin/orca screen reader, because
 * Orca's Linux CLI installs as `orca-ide` to avoid claiming that name (stablyai/orca#7904); on
 * packaged macOS/Windows it reached this app's bundled CLI only if the user had separately
 * registered the CLI globally.
 *
 * `platform` is a test seam only: production leaves it unset and reads `process.platform`, so
 * every branch behaves exactly as it did inside `buildPtyHostEnv`.
 */

import { delimiter, join } from 'node:path'
import { readInheritedPath } from '../ipc/pty/host-env/path'
import { resolvePathEnvKey } from '../pty/windows-environment-path'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'

export type OrcaCliChildPathOptions = {
  isPackaged: boolean
  userDataPath: string
  resourcesPath?: string | null
  /** Test seam — production reads the real platform, which is what every branch below assumes. */
  platform?: NodeJS.Platform
}

/** Mutates `env` in place, prepending the directory that makes bare `orca` this app's CLI. */
export function prependOrcaCliDirToChildPath(
  env: Record<string, string>,
  opts: OrcaCliChildPathOptions
): void {
  const platform = opts.platform ?? process.platform
  // Why: matches node:path's `delimiter` for the running platform, but stays correct when a test
  // drives a foreign platform through the seam.
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  // Why: dev mode needs the launcher PATH override so `orca` resolves to the dev build instead of the production binary at /usr/local/bin/orca.
  if (!opts.isPackaged) {
    const devCliBin = join(opts.userDataPath, 'cli', 'bin')
    const inheritedPath = readInheritedPath(env, platform)
    // Why: an empty PATH segment resolves as `.` in some shells (commands run from cwd); avoid a trailing delimiter.
    env[resolvePathEnvKey(env, platform)] = inheritedPath
      ? `${devCliBin}${pathDelimiter}${inheritedPath}`
      : devCliBin
  } else if (platform === 'linux') {
    // Why: bare-`orca` shim scoped to Orca PTYs — Linux CLI installs as `orca-ide` to avoid shadowing GNOME's /usr/bin/orca screen reader (stablyai/orca#7904).
    const shimDir = ensureLinuxTerminalOrcaCliShimDir({ userDataPath: opts.userDataPath })
    if (shimDir) {
      const inheritedEntries = readInheritedPath(env, platform)
        .split(pathDelimiter)
        .filter((entry) => entry.length > 0 && entry !== shimDir)
      env.PATH = [shimDir, ...inheritedEntries].join(pathDelimiter)
    }
  } else if (opts.resourcesPath && (platform === 'darwin' || platform === 'win32')) {
    // Why: global CLI registration is optional, but agents in Orca-managed PTYs must always reach this app's bundled CLI.
    const bundledCliBin = join(opts.resourcesPath, 'bin')
    const inheritedPath = readInheritedPath(env, platform)
    env[resolvePathEnvKey(env, platform)] = inheritedPath
      ? `${bundledCliBin}${pathDelimiter}${inheritedPath}`
      : bundledCliBin
  }
}
