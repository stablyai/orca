import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

type HostCodexManagedHomeOwnershipOptions = {
  candidatePath: string
  managedAccountsRoot: string
  systemCodexHomePath: string
  expectedAccountId?: string
}

export const MISSING_MANAGED_HOME_MESSAGE = 'Managed Codex home directory does not exist on disk.'

/**
 * Why: the gate answers two different questions and callers act on them very
 * differently. `untrusted` is a *successful observation* that failed a trust
 * check (or a definitive absence where absence is itself the verdict), and only
 * it may clear the user's persisted account selection. `indeterminate` means we
 * could not read the home at all — the home may be perfectly valid, so callers
 * must refuse to *use* it without erasing durable state (#STA-4422: one EBUSY
 * from an antivirus lock used to log the user out permanently).
 */
export type HostCodexManagedHomeVerdict =
  | { kind: 'owned'; homePath: string }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'indeterminate'; error: unknown }

/** Thrown for a proven trust failure; safe to clear selection on. */
export class UntrustedManagedCodexHomeError extends Error {}

/**
 * Thrown when the home could not be read. Callers must refuse the operation and
 * leave persisted selection, credentials, and managed directories untouched.
 */
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

/**
 * Why: the system Codex home is optional — a user with no ~/.codex is normal,
 * and its absence says nothing about the managed candidate. Only a definitive
 * absence may fall back to the resolved spelling; any other read error is
 * inconclusive and must reach the caller as `indeterminate`.
 */
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

  // Why: absence of the candidate IS the structural verdict here, but only a
  // definitive one. `existsSync` used to fold EPERM into "does not exist", which
  // is what made an antivirus lock look like a deleted account.
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

  if (expectedAccountId !== undefined) {
    const candidateUsesManagedRootSpelling =
      pathIsInsideOrEqual(resolvedRoot, resolvedCandidate) ||
      pathIsInsideOrEqual(canonicalRoot, resolvedCandidate)
    let canonicalExpectedHome: string
    try {
      canonicalExpectedHome = canonicalizeIfPresent(join(canonicalRoot, expectedAccountId, 'home'))
    } catch (error) {
      return { kind: 'indeterminate', error }
    }
    if (
      !candidateUsesManagedRootSpelling ||
      !pathsEqual(canonicalCandidate, canonicalExpectedHome)
    ) {
      return {
        kind: 'untrusted',
        reason: 'Managed Codex home does not match its persisted account ID.'
      }
    }
  }

  // Why: a replaced codex-accounts directory could otherwise redirect config,
  // hook, or resource writes into the user's real ~/.codex tree.
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

  const markerPath = join(canonicalCandidate, '.orca-managed-home')
  let markerIsRegularFile: boolean
  let markerContents: string
  try {
    markerIsRegularFile = lstatSync(markerPath).isFile()
    markerContents = markerIsRegularFile ? readFileSync(markerPath, 'utf-8') : ''
  } catch (error) {
    // Why: the marker is required, so its definitive absence is structural — but
    // an unreadable marker is not evidence of anything.
    if (isDefinitiveAbsence(error)) {
      return { kind: 'untrusted', reason: 'Managed Codex home is missing Orca ownership marker.' }
    }
    return { kind: 'indeterminate', error }
  }
  if (!markerIsRegularFile) {
    return {
      kind: 'untrusted',
      reason: 'Managed Codex home ownership marker is not a regular file.'
    }
  }
  if (expectedAccountId !== undefined && markerContents.trim() !== expectedAccountId) {
    return {
      kind: 'untrusted',
      reason: 'Managed Codex home ownership marker does not match its account ID.'
    }
  }

  return { kind: 'owned', homePath: canonicalCandidate }
}

/** Non-throwing verdict; callers decide how to treat each kind. */
export function resolveHostCodexManagedHomeVerdict(
  options: HostCodexManagedHomeOwnershipOptions
): HostCodexManagedHomeVerdict {
  return evaluate(options)
}

/**
 * Throwing wrapper for write paths (add, re-auth, migration) that must never
 * proceed on an unproven home. Distinct error classes keep an unreadable home
 * from being mistaken for a deleted one — `isMissingManagedHomeError` must not
 * match the temporary case, or re-auth would recreate the home and rewrite its
 * ownership marker after a transient stat failure.
 */
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
