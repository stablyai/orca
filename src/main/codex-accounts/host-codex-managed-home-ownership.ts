import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

type HostCodexManagedHomeOwnershipOptions = {
  candidatePath: string
  managedAccountsRoot: string
  systemCodexHomePath: string
  expectedAccountId?: string
}

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

function pathIsInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath)
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  )
}

function canonicalizeIfPresent(candidatePath: string): string {
  const resolvedPath = resolve(candidatePath)
  return existsSync(resolvedPath) ? realpathSync(resolvedPath) : resolvedPath
}

/**
 * Proves a host managed home is an Orca-owned account directory and cannot
 * resolve into the user's real CODEX_HOME before callers write launch state.
 */
export function assertOwnedHostCodexManagedHomePath({
  candidatePath,
  managedAccountsRoot,
  systemCodexHomePath,
  expectedAccountId
}: HostCodexManagedHomeOwnershipOptions): string {
  const resolvedCandidate = resolve(candidatePath)
  const resolvedRoot = resolve(managedAccountsRoot)
  if (!existsSync(resolvedCandidate)) {
    throw new Error('Managed Codex home directory does not exist on disk.')
  }
  // Why: macOS can spell one path as /var and /private/var, while a replaced
  // path component must still be caught as a canonical containment escape.
  const canonicalCandidate = realpathSync(resolvedCandidate)
  const canonicalRoot = realpathSync(resolvedRoot)
  const canonicalSystemHome = canonicalizeIfPresent(systemCodexHomePath)
  if (expectedAccountId !== undefined) {
    const candidateUsesManagedRootSpelling =
      pathIsInsideOrEqual(resolvedRoot, resolvedCandidate) ||
      pathIsInsideOrEqual(canonicalRoot, resolvedCandidate)
    const canonicalExpectedHome = canonicalizeIfPresent(
      join(canonicalRoot, expectedAccountId, 'home')
    )
    if (
      !candidateUsesManagedRootSpelling ||
      !pathsEqual(canonicalCandidate, canonicalExpectedHome)
    ) {
      throw new Error('Managed Codex home does not match its persisted account ID.')
    }
  }
  // Why: a replaced codex-accounts directory could otherwise redirect config,
  // hook, or resource writes into the user's real ~/.codex tree.
  if (pathIsInsideOrEqual(canonicalSystemHome, canonicalCandidate)) {
    throw new Error('Managed Codex home resolves inside the system Codex home.')
  }
  if (
    !pathIsInsideOrEqual(canonicalRoot, canonicalCandidate) ||
    canonicalRoot === canonicalCandidate
  ) {
    throw new Error(
      `Managed Codex home is outside current storage root (expected under ${canonicalRoot}).`
    )
  }

  const markerPath = join(canonicalCandidate, '.orca-managed-home')
  let markerIsRegularFile: boolean
  try {
    markerIsRegularFile = lstatSync(markerPath).isFile()
  } catch (error) {
    throw new Error('Managed Codex home is missing Orca ownership marker.', { cause: error })
  }
  if (!markerIsRegularFile) {
    throw new Error('Managed Codex home ownership marker is not a regular file.')
  }
  const markerContents = readFileSync(markerPath, 'utf-8')
  if (expectedAccountId !== undefined && markerContents.trim() !== expectedAccountId) {
    throw new Error('Managed Codex home ownership marker does not match its account ID.')
  }

  return canonicalCandidate
}
