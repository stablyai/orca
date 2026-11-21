import { lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** `$XDG_RUNTIME_DIR/<name>` when set, then `<tmpdir>/<name>-<uid>`. */
export function privateRuntimeDirectoryCandidates(name: string, uid: number): string[] {
  const candidates: string[] = []
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR
  if (xdgRuntimeDir && isAbsolute(xdgRuntimeDir)) {
    candidates.push(join(xdgRuntimeDir, name))
  }
  candidates.push(join(tmpdir(), `${name}-${uid}`))
  return candidates
}

/** The first candidate that is, or can be made, a directory only this user can reach. */
export function findPrivateRuntimeDirectory(name: string, uid: number): string | null {
  return (
    privateRuntimeDirectoryCandidates(name, uid).find((dir) => ensurePrivateDirectory(dir, uid)) ??
    null
  )
}

export function ensurePrivateDirectory(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Existing mkdir mode is ignored; lstat plus owner/perms checks prevent symlink swaps and cross-user access.
    const st = lstatSync(dir)
    return st.isDirectory() && st.uid === uid && (st.mode & 0o77) === 0
  } catch {
    return false
  }
}
