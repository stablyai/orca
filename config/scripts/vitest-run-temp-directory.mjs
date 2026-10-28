import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests bind Unix sockets below the temp root; on macOS (104-byte sun_path) some fail about four chars
// past its 50-char default root, so a run root never grows past that and macOS's default falls back to /tmp.
const MAX_POSIX_ROOT_LENGTH = 50
const RUN_DIRECTORY = /^ov([0-9a-z]+)$/
// Only directories carrying it are ours to sweep; a bare `ov…` name could belong to anyone.
const MARKER = '.orca-vitest-run'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function remove(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 })
}

/** Run directories whose launcher died before it could remove them. */
export function sweepStaleRunDirectories(base, { ownPid = process.pid, alive = isAlive } = {}) {
  let names
  try {
    names = readdirSync(base)
  } catch {
    return
  }
  for (const name of names) {
    const pid = Number.parseInt(RUN_DIRECTORY.exec(name)?.[1] ?? '', 36)
    const path = join(base, name)
    if (pid > 0 && pid !== ownPid && !alive(pid) && existsSync(join(path, MARKER))) {
      try {
        remove(path)
      } catch {
        // Another launcher may be sweeping it too.
      }
    }
  }
}

export function resolveRunTempBase(base, name, platform = process.platform) {
  return platform !== 'win32' && join(base, name).length > MAX_POSIX_ROOT_LENGTH ? '/tmp' : base
}

/** A per-run temp root, so files tests leave in os.tmpdir() go when the run ends; null keeps the inherited one. */
export function createRunTempDirectory({ base: requested = tmpdir(), pid = process.pid } = {}) {
  const name = `ov${pid.toString(36)}`
  const base = resolveRunTempBase(requested, name)
  sweepStaleRunDirectories(base, { ownPid: pid })
  const path = join(base, name)
  if (existsSync(path)) {
    if (!existsSync(join(path, MARKER))) {
      return null
    }
    // A dead run that had this pid left it behind.
    remove(path)
  }
  try {
    mkdirSync(path)
    writeFileSync(join(path, MARKER), '')
  } catch {
    return null
  }
  return {
    path,
    // os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows.
    env: { TMPDIR: path, TEMP: path, TMP: path },
    remove: () => {
      try {
        remove(path)
      } catch {
        // A straggling child still holds a file (Windows); the next run's sweep removes it.
      }
    }
  }
}
