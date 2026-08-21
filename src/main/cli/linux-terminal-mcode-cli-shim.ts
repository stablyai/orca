import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBareMCodeCliScript } from './linux-bare-mcode-dispatcher'

const SHIM_DIR_NAME = 'linux-mcode-cli-shim'

// Why: rewriting the shim on every PTY spawn is wasted fs work; the target only
// changes with the install itself, so one successful write per process is enough.
// Failures are NOT cached so a transient fs error retries on the next spawn.
const ensuredShimDirs = new Map<string, string>()

export type LinuxTerminalMCodeCliShimOptions = {
  userDataPath: string
  /** Test seam — defaults to the packaged resources root. */
  resourcesPath?: string | null
  /** Test seam — defaults to $APPIMAGE (set only when running from an AppImage). */
  appImagePath?: string | null
}

// Why: on Linux the CLI installs as `mcode-ide` so it never shadows the GNOME
// MCode screen reader at /usr/bin/mcode — but agent-facing surfaces (skills,
// dispatch preambles, CLI hints) all invoke bare `mcode`, so on stock Ubuntu an
// agent inside an MCode terminal would launch the screen reader instead
// (mcode-ide/mcode#7904). Prepending this userData-scoped shim dir to managed-PTY
// PATH makes bare `mcode` resolve to the MCode CLI inside MCode terminals only,
// leaving the user's own shells (and their screen reader) untouched.
export function ensureLinuxTerminalMCodeCliShimDir(
  options: LinuxTerminalMCodeCliShimOptions
): string | null {
  const cached = ensuredShimDirs.get(options.userDataPath)
  if (cached !== undefined) {
    return cached
  }

  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath) {
    return null
  }
  const resolved = buildBareMCodeCliScript(
    resourcesPath,
    options.appImagePath ?? process.env.APPIMAGE ?? null
  )
  if (!resolved) {
    return null
  }

  const shimDir = join(options.userDataPath, SHIM_DIR_NAME)
  const shimPath = join(shimDir, 'mcode')
  try {
    if (readShim(shimPath) !== resolved.script) {
      mkdirSync(shimDir, { recursive: true })
      writeFileSync(shimPath, resolved.script, 'utf8')
    }
    // Why: always re-assert the exec bit — a shim written by an older run (or
    // restored from backup) with mode stripped would fail every agent CLI call.
    chmodSync(shimPath, 0o755)
  } catch {
    return null
  }
  ensuredShimDirs.set(options.userDataPath, shimDir)
  return shimDir
}

function readShim(shimPath: string): string | null {
  try {
    return readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
}
