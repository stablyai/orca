import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'

const MANAGED_AUTH_MARKER = '.orca-managed-antigravity-auth'

export function getAntigravityManagedAccountsRoot(): string {
  return join(app.getPath('userData'), 'antigravity-accounts')
}

export function resolveOwnedAntigravityManagedAuthPath(
  accountId: string,
  candidatePath: string
): string | null {
  const rootPath = getAntigravityManagedAccountsRoot()
  const resolvedCandidate = resolve(candidatePath)
  if (!existsSync(resolvedCandidate) || !existsSync(rootPath)) {
    return null
  }
  try {
    if (lstatSync(resolvedCandidate).isSymbolicLink()) {
      return null
    }
    const canonicalCandidate = realpathSync(resolvedCandidate)
    const canonicalRoot = realpathSync(rootPath)
    if (
      canonicalCandidate === canonicalRoot ||
      !canonicalCandidate.startsWith(canonicalRoot + sep)
    ) {
      return null
    }
    const relativePath = relative(canonicalRoot, canonicalCandidate)
    const relativeParts = relativePath.split(sep)
    const escaped = relativePath.startsWith('..') || relativePath.includes(`..${sep}`)
    if (
      escaped ||
      relativeParts.length !== 2 ||
      relativeParts[0] !== accountId ||
      relativeParts[1] !== 'auth'
    ) {
      return null
    }
    const markerPath = join(canonicalCandidate, MANAGED_AUTH_MARKER)
    if (!isManagedAuthMarkerValid(markerPath, accountId)) {
      writeFileSync(markerPath, `${accountId}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    }
    if (!isManagedAuthMarkerValid(markerPath, accountId)) {
      return null
    }
    return canonicalCandidate
  } catch {
    return null
  }
}

function isManagedAuthMarkerValid(markerPath: string, accountId: string): boolean {
  try {
    const content = readFileSync(markerPath, 'utf-8').trim()
    return content === accountId
  } catch {
    return false
  }
}

export function readAntigravityManagedAuthFile(
  managedAuthPath: string,
  filename: string
): string | null {
  try {
    const filePath = join(managedAuthPath, filename)
    if (!existsSync(filePath)) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function writeAntigravityManagedAuthFile(
  managedAuthPath: string,
  filename: string,
  content: string
): void {
  writeFileSync(join(managedAuthPath, filename), content, {
    encoding: 'utf-8',
    mode: 0o600
  })
}
