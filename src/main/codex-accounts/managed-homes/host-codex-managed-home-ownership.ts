import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'

type HostCodexManagedHomeOwnershipOptions = {
  candidatePath: string
  managedAccountsRoot: string
  systemCodexHomePath: string
  expectedAccountId?: string
}

export const MISSING_MANAGED_HOME_MESSAGE = 'Managed Codex home directory does not exist on disk.'

export const MANAGED_HOME_MARKER = '.orca-managed-home'
/**
 * Replaces the marker before a Windows home gets junctions: older builds refuse to use or delete
 * a home without the first one, and their recursive delete would follow a junction into ~/.codex.
 */
export const LINKED_MANAGED_HOME_MARKER = '.orca-managed-home-linked'

// The linked marker is read second: a share pass renames the first into it, never back, so a
// rename landing between the two reads still finds one of them.
function readMarker(home: string): { isFile: boolean; contents: string } {
  for (const name of [MANAGED_HOME_MARKER, LINKED_MANAGED_HOME_MARKER]) {
    const path = join(home, name)
    try {
      const isFile = lstatSync(path).isFile()
      return { isFile, contents: isFile ? readFileSync(path, 'utf-8') : '' }
    } catch (error) {
      if (name === LINKED_MANAGED_HOME_MARKER || !isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }
  throw new Error('unreachable')
}

/** Only `untrusted` may clear selection; `indeterminate` must refuse use without erasing state. */
export type HostCodexManagedHomeVerdict =
  | { kind: 'owned'; homePath: string }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'indeterminate'; error: unknown }

/** Thrown for a proven trust failure; safe to clear selection on. */
export class UntrustedManagedCodexHomeError extends Error {}

/** Refuse the operation while preserving selection, credentials and home directories. */
export class ManagedCodexHomeTemporarilyUnavailableError extends Error {
  constructor(
    message = 'Codex account files are temporarily locked. Retry in a moment.',
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
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

// Missing optional homes can use resolved paths; other read failures must remain indeterminate.
function canonicalizeIfPresent(candidatePath: string): string {
  const resolvedPath = resolve(candidatePath)
  try {
    return realpathSync(resolvedPath)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return resolvedPath
    }
    throw error
  }
}

function evaluate({
  candidatePath,
  managedAccountsRoot,
  systemCodexHomePath,
  expectedAccountId
}: HostCodexManagedHomeOwnershipOptions): HostCodexManagedHomeVerdict {
  const resolvedCandidate = resolve(candidatePath)
  const resolvedRoot = resolve(managedAccountsRoot)

  // Avoid existsSync: it conflates a missing home with transient permission failures.
  let canonicalCandidate: string
  try {
    statSync(resolvedCandidate)
    canonicalCandidate = realpathSync(resolvedCandidate)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return { kind: 'untrusted', reason: MISSING_MANAGED_HOME_MESSAGE }
    }
    return { kind: 'indeterminate', error }
  }

  let canonicalRoot: string
  let canonicalSystemHome: string
  try {
    canonicalRoot = realpathSync(resolvedRoot)
    canonicalSystemHome = canonicalizeIfPresent(systemCodexHomePath)
  } catch (error) {
    return { kind: 'indeterminate', error }
  }

  let canonicalExpectedHome: string | undefined
  try {
    canonicalExpectedHome =
      expectedAccountId === undefined
        ? undefined
        : canonicalizeIfPresent(join(canonicalRoot, expectedAccountId, 'home'))
  } catch (error) {
    return { kind: 'indeterminate', error }
  }
  const pathFailure = evaluateCanonicalPaths({
    resolvedCandidate,
    resolvedRoot,
    canonicalCandidate,
    canonicalRoot,
    canonicalSystemHome,
    canonicalExpectedHome
  })
  if (pathFailure) {
    return pathFailure
  }

  let markerIsRegularFile: boolean
  let markerContents: string
  try {
    const marker = readMarker(canonicalCandidate)
    markerIsRegularFile = marker.isFile
    markerContents = marker.contents
  } catch (error) {
    // A missing ownership marker disproves trust; an unreadable one leaves it unknown.
    if (isDefinitiveAbsence(error)) {
      return { kind: 'untrusted', reason: 'Managed Codex home is missing Orca ownership marker.' }
    }
    return { kind: 'indeterminate', error }
  }
  const markerFailure = evaluateMarker(markerIsRegularFile, markerContents, expectedAccountId)
  if (markerFailure) {
    return markerFailure
  }

  return { kind: 'owned', homePath: canonicalCandidate }
}

export function resolveHostCodexManagedHomeVerdict(
  options: HostCodexManagedHomeOwnershipOptions
): HostCodexManagedHomeVerdict {
  return evaluate(options)
}

function evaluateCanonicalPaths(paths: {
  resolvedCandidate: string
  resolvedRoot: string
  canonicalCandidate: string
  canonicalRoot: string
  canonicalSystemHome: string
  canonicalExpectedHome: string | undefined
}): Extract<HostCodexManagedHomeVerdict, { kind: 'untrusted' }> | null {
  const {
    resolvedCandidate,
    resolvedRoot,
    canonicalCandidate,
    canonicalRoot,
    canonicalSystemHome,
    canonicalExpectedHome
  } = paths
  if (
    canonicalExpectedHome !== undefined &&
    ((!pathIsInsideOrEqual(resolvedRoot, resolvedCandidate) &&
      !pathIsInsideOrEqual(canonicalRoot, resolvedCandidate)) ||
      !pathsEqual(canonicalCandidate, canonicalExpectedHome))
  ) {
    return {
      kind: 'untrusted',
      reason: 'Managed Codex home does not match its persisted account ID.'
    }
  }
  if (pathIsInsideOrEqual(canonicalSystemHome, canonicalCandidate)) {
    return {
      kind: 'untrusted',
      reason: 'Managed Codex home resolves inside the system Codex home.'
    }
  }
  if (
    !pathIsInsideOrEqual(canonicalRoot, canonicalCandidate) ||
    canonicalRoot === canonicalCandidate
  ) {
    return {
      kind: 'untrusted',
      reason: `Managed Codex home is outside current storage root (expected under ${canonicalRoot}).`
    }
  }
  return null
}

function evaluateMarker(
  isFile: boolean,
  contents: string,
  expectedAccountId: string | undefined
): Extract<HostCodexManagedHomeVerdict, { kind: 'untrusted' }> | null {
  if (!isFile) {
    return {
      kind: 'untrusted',
      reason: 'Managed Codex home ownership marker is not a regular file.'
    }
  }
  if (expectedAccountId !== undefined && contents.trim() !== expectedAccountId) {
    return {
      kind: 'untrusted',
      reason: 'Managed Codex home ownership marker does not match its account ID.'
    }
  }
  return null
}

async function canonicalizeIfPresentAsync(path: string): Promise<string> {
  try {
    return await realpath(resolve(path))
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return resolve(path)
    }
    throw error
  }
}

/** Read-only consumers must not run the ownership filesystem checks on the host event loop. */
export async function resolveHostCodexManagedHomeVerdictAsync({
  candidatePath,
  managedAccountsRoot,
  systemCodexHomePath,
  expectedAccountId
}: HostCodexManagedHomeOwnershipOptions): Promise<HostCodexManagedHomeVerdict> {
  const resolvedCandidate = resolve(candidatePath)
  const resolvedRoot = resolve(managedAccountsRoot)
  let canonicalCandidate: string
  try {
    await stat(resolvedCandidate)
    canonicalCandidate = await realpath(resolvedCandidate)
  } catch (error) {
    return isDefinitiveAbsence(error)
      ? { kind: 'untrusted', reason: MISSING_MANAGED_HOME_MESSAGE }
      : { kind: 'indeterminate', error }
  }
  try {
    const canonicalRoot = await realpath(resolvedRoot)
    const pathFailure = evaluateCanonicalPaths({
      resolvedCandidate,
      resolvedRoot,
      canonicalCandidate,
      canonicalRoot,
      canonicalSystemHome: await canonicalizeIfPresentAsync(systemCodexHomePath),
      canonicalExpectedHome:
        expectedAccountId === undefined
          ? undefined
          : await canonicalizeIfPresentAsync(join(canonicalRoot, expectedAccountId, 'home'))
    })
    if (pathFailure) {
      return pathFailure
    }
  } catch (error) {
    return { kind: 'indeterminate', error }
  }
  for (const name of [MANAGED_HOME_MARKER, LINKED_MANAGED_HOME_MARKER]) {
    try {
      const path = join(canonicalCandidate, name)
      const isFile = (await lstat(path)).isFile()
      const failure = evaluateMarker(
        isFile,
        isFile ? await readFile(path, 'utf8') : '',
        expectedAccountId
      )
      return failure ?? { kind: 'owned', homePath: canonicalCandidate }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return { kind: 'indeterminate', error }
      }
    }
  }
  return { kind: 'untrusted', reason: 'Managed Codex home is missing Orca ownership marker.' }
}

/** Distinct errors prevent transient read failures from triggering home recreation during reauth. */
export function assertOwnedHostCodexManagedHomePath(
  options: HostCodexManagedHomeOwnershipOptions
): string {
  const verdict = evaluate(options)
  if (verdict.kind === 'owned') {
    return verdict.homePath
  }
  if (verdict.kind === 'untrusted') {
    throw new UntrustedManagedCodexHomeError(verdict.reason)
  }
  throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: verdict.error })
}
