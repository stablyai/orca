import { resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'

/**
 * Check whether resolvedTarget is equal to or a descendant of resolvedBase.
 * Uses relative() so it works with both `/` (Unix) and `\` (Windows) separators.
 *
 * Compared byte-exactly first, then across Unicode forms — but only where both spellings prove to
 * be one filesystem object.
 */
export function isDescendantOrEqual(resolvedTarget: string, resolvedBase: string): boolean {
  if (isDescendantOrEqualExact(resolvedTarget, resolvedBase)) {
    return true
  }
  const ancestor = foldedContainmentAncestor(resolvedTarget, resolvedBase)
  return ancestor !== null && isSameFilesystemObject(ancestor, resolvedBase)
}

function isDescendantOrEqualExact(resolvedTarget: string, resolvedBase: string): boolean {
  if (resolvedTarget === resolvedBase) {
    return true
  }
  const rel = relative(resolvedBase, resolvedTarget)
  // Security: reject "..", "../…" or an absolute rel — on Windows relative() returns absolute across drives, which would bypass drive-traversal checks.
  // Use isAbsolute, not rejoin+compare: Windows path.relative() ignores drive/root casing, so rejoining would deny valid c:\repo under C:\Repo.
  return rel !== '' && !(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel)
}

/**
 * Why a loop and not a regex: `[^\u0000-\u007f]` trips no-control-regex, and this runs once per
 * registered root on every filesystem IPC, where charCodeAt beats an ICU-backed scan anyway.
 */
function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return true
    }
  }
  return false
}

/**
 * The same name, spelled two ways.
 *
 * macOS returns a path in whichever Unicode form its source held: APFS gives back the form it
 * stores — NFD for names typed into Finder — while the file picker and git (`core.precomposeunicode`)
 * give back NFC. A workspace whose path contains Korean, accented or otherwise composed characters
 * is registered in one form and read in the other, so byte comparison puts the file outside its own
 * workspace and fs:readFile denies a path the user is looking at (#21172). ASCII paths are immune,
 * which is why the guard held for so long.
 *
 * Canonical equivalence is not containment on its own: APFS folds both spellings onto one
 * directory, ext4 keeps them as distinct siblings, and the unregistered sibling is not the root —
 * equivalence includes singletons such as U+212A KELVIN SIGN folding to K. So the fold only locates
 * the candidate ancestor, in the caller's spelling; isDescendantOrEqual settles identity.
 *
 * Walks up by component count, never by offset: NFD is longer than NFC.
 */
function foldedContainmentAncestor(resolvedTarget: string, resolvedBase: string): string | null {
  // Both sides must carry non-ASCII before normalize() earns its allocation: ASCII is identical in
  // every form, so a mismatch confined to it is a real one. Target first — it is the side the
  // allow-list scan holds fixed while it walks every registered root.
  if (!hasNonAscii(resolvedTarget) || !hasNonAscii(resolvedBase)) {
    return null
  }
  const foldedBase = resolvedBase.normalize('NFC')
  const foldedTarget = resolvedTarget.normalize('NFC')
  if (!isDescendantOrEqualExact(foldedTarget, foldedBase)) {
    return null
  }
  const descent = relative(foldedBase, foldedTarget)
  let ancestor = resolvedTarget
  for (let depth = descent === '' ? 0 : descent.split(sep).length; depth > 0; depth -= 1) {
    ancestor = dirname(ancestor)
  }
  return ancestor
}

/**
 * The same directory entry, not merely the same name — the question the fold is really asking, and
 * only the filesystem can answer it.
 *
 * Fails closed: an ancestor that cannot be stat'ed has not shown it is the registered root, and ino
 * is 0 on volumes that expose none. Reached only on a containment the exact comparison refused, so
 * ASCII paths and non-folding roots still touch no disk.
 */
function isSameFilesystemObject(pathA: string, pathB: string): boolean {
  try {
    const statA = statSync(pathA)
    const statB = statSync(pathB)
    return statA.ino !== 0 && statA.dev === statB.dev && statA.ino === statB.ino
  } catch {
    return false
  }
}

/**
 * Node's canonical ENOENT message. Matched in full so a message that merely mentions the word — a
 * log line, a user's branch name — cannot be mistaken for a missing path.
 */
const ENOENT_MESSAGE = /\bENOENT: no such file or directory\b/

export function isENOENT(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if ('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return true
  }
  // Why the message is also consulted: an error raised on an SSH host crosses the relay as JSON-RPC,
  // and ssh-channel-multiplexer rebuilds it with the TRANSPORT's numeric code (msg.error.code), so
  // Node's 'ENOENT' string code no longer exists on the object by the time any caller sees it. Every
  // caller here asks the same question — "is this path simply absent?" — and for a remote path the
  // answer was unreachable: remotePathExists rethrew instead of returning false, which surfaced as a
  // raw "ENOENT: no such file or directory, lstat '<path>'" when creating a worktree over SSH.
  //
  // The cost, accepted rather than overlooked: a remote host can make an unrelated failure read as
  // "absent" by putting that sentence in a message. Narrowing back to the code alone is not an
  // option — the transport overwrites it, which IS the bug — and the blast radius is a host already
  // trusted to run our relay. normalizeExistingPath is unaffected either way: its realpath runs
  // locally and always carries a real .code, so symlink containment cannot be spoofed this way.
  return ENOENT_MESSAGE.test(error.message)
}

export async function normalizeExistingPath(resolvedPath: string): Promise<string> {
  try {
    return resolve(await realpath(resolvedPath))
  } catch (error) {
    if (isENOENT(error)) {
      return resolvedPath
    }
    throw error
  }
}

export function validateGitRelativeFilePath(worktreePath: string, filePath: string): string {
  if (!filePath || filePath.includes('\0') || resolve(filePath) === filePath) {
    throw new Error('Access denied: invalid git file path')
  }

  const resolvedFilePath = resolve(worktreePath, filePath)
  if (!isDescendantOrEqual(resolvedFilePath, worktreePath)) {
    throw new Error('Access denied: git file path escapes the selected worktree')
  }

  const normalizedRelativePath = relative(worktreePath, resolvedFilePath)
  if (!normalizedRelativePath) {
    throw new Error('Access denied: invalid git file path')
  }

  return normalizedRelativePath
}

export function validateFullGitObjectId(value: string, label: string): string {
  const pattern = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
  if (!pattern.test(value)) {
    throw new Error(`${label} must be a full git object id`)
  }
  return value
}
