import { resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

/** Check native-path containment; accept Unicode-equivalent spellings only after proving filesystem identity. */
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
  // Reject parent/cross-drive escapes with isAbsolute; rejoin comparison would wrongly reject Windows drive/root case differences.
  return rel !== '' && !(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel)
}

/** Avoid ICU scans and control-character regex linting on this per-root hot path. */
function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      return true
    }
  }
  return false
}

/** Locate a Unicode-equivalent ancestor by component count; NFD is longer than NFC. Filesystem identity must still prove containment (#21172). */
function foldedContainmentAncestor(resolvedTarget: string, resolvedBase: string): string | null {
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

/** Fail closed unless both spellings have a nonzero inode and match filesystem identity; folded names alone can be distinct on ext4. */
function isSameFilesystemObject(pathA: string, pathB: string): boolean {
  try {
    const statA = statSync(pathA)
    const statB = statSync(pathB)
    return statA.ino !== 0 && statA.dev === statB.dev && statA.ino === statB.ino
  } catch {
    return false
  }
}

// Match the full Node phrase so unrelated ENOENT mentions cannot imply absence.
const ENOENT_MESSAGE = /\bENOENT: no such file or directory\b/

export function isENOENT(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  if ('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return true
  }
  // Relay RPC replaces Node codes; accept its canonical message from trusted hosts. Local realpath containment still uses actual filesystem identity.
  return ENOENT_MESSAGE.test(error.message)
}

/** An existence probe's "not there": also ENOTDIR, since `file.txt/child` cannot exist either. */
export function isPathAbsentError(error: unknown): boolean {
  return isENOENT(error) || isDefinitiveAbsence(error)
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
