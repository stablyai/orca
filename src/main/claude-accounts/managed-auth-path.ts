import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

const MANAGED_AUTH_MARKER = '.orca-managed-claude-auth'

export type ClaudeManagedAuthOwnershipVerdict =
  | { kind: 'owned'; authPath: string }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'indeterminate'; error: unknown }

export class ClaudeManagedAuthTemporarilyUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Claude managed auth storage is temporarily unavailable.', options)
  }
}

export function getClaudeManagedAccountsRoot(): string {
  return join(app.getPath('userData'), 'claude-accounts')
}

function pathIsInsideOrEqual(rootPath: string, candidatePath: string): boolean {
  const value = relative(rootPath, candidatePath)
  return value === '' || (!value.startsWith('..') && !value.includes(`..${sep}`))
}

function canonicalizeIfPresent(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return resolve(path)
    }
    throw error
  }
}

/** Non-throwing ownership check; indeterminate must never be treated as absent. */
export function resolveClaudeManagedAuthOwnership(
  accountId: string,
  candidatePath: string
): ClaudeManagedAuthOwnershipVerdict {
  const resolvedCandidate = resolve(candidatePath)
  const resolvedRoot = resolve(getClaudeManagedAccountsRoot())
  let canonicalCandidate: string
  let canonicalRoot: string
  let canonicalSystemHome: string
  try {
    if (lstatSync(resolvedRoot).isSymbolicLink()) {
      return { kind: 'untrusted', reason: 'Claude managed accounts root is a symlink.' }
    }
    statSync(resolvedCandidate)
    if (lstatSync(resolvedCandidate).isSymbolicLink()) {
      return { kind: 'untrusted', reason: 'Claude managed auth path is a symlink.' }
    }
    canonicalRoot = realpathSync(resolvedRoot)
    canonicalCandidate = realpathSync(resolvedCandidate)
    canonicalSystemHome = canonicalizeIfPresent(join(homedir(), '.claude'))
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return { kind: 'untrusted', reason: 'Managed Claude auth directory does not exist on disk.' }
    }
    return { kind: 'indeterminate', error }
  }

  let canonicalExpected: string
  try {
    canonicalExpected = canonicalizeIfPresent(join(canonicalRoot, accountId, 'auth'))
  } catch (error) {
    return { kind: 'indeterminate', error }
  }
  if (
    !pathIsInsideOrEqual(canonicalRoot, canonicalCandidate) ||
    canonicalCandidate === canonicalRoot ||
    canonicalCandidate !== canonicalExpected
  ) {
    return { kind: 'untrusted', reason: 'Managed Claude auth path is outside its account root.' }
  }
  if (pathIsInsideOrEqual(canonicalSystemHome, canonicalCandidate)) {
    return {
      kind: 'untrusted',
      reason: 'Managed Claude auth resolves inside the system Claude home.'
    }
  }

  const markerPath = join(canonicalCandidate, MANAGED_AUTH_MARKER)
  let markerContents: string
  try {
    const markerStat = lstatSync(markerPath)
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return { kind: 'untrusted', reason: 'Managed Claude auth marker is not a regular file.' }
    }
    markerContents = readFileSync(markerPath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return { kind: 'untrusted', reason: 'Managed Claude auth marker is missing.' }
    }
    return { kind: 'indeterminate', error }
  }
  if (markerContents.trim() !== accountId) {
    return {
      kind: 'untrusted',
      reason: 'Managed Claude auth marker does not match its account ID.'
    }
  }
  return { kind: 'owned', authPath: canonicalCandidate }
}

export function resolveOwnedClaudeManagedAuthPath(
  accountId: string,
  candidatePath: string,
  options: { adoptLegacyMarker?: boolean } = {}
): string | null {
  let verdict = resolveClaudeManagedAuthOwnership(accountId, candidatePath)
  if (verdict.kind === 'untrusted' && options.adoptLegacyMarker) {
    const root = resolve(getClaudeManagedAccountsRoot())
    const expected = join(root, accountId, 'auth')
    try {
      if (resolve(candidatePath) === expected && statSync(expected).isDirectory()) {
        writeFileSync(join(expected, MANAGED_AUTH_MARKER), `${accountId}\n`, {
          encoding: 'utf-8',
          mode: 0o600,
          flag: 'wx'
        })
        verdict = resolveClaudeManagedAuthOwnership(accountId, candidatePath)
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        return null
      }
    }
  }
  return verdict.kind === 'owned' ? verdict.authPath : null
}

export function assertOwnedClaudeManagedAuthPath(accountId: string, candidatePath: string): string {
  const verdict = resolveClaudeManagedAuthOwnership(accountId, candidatePath)
  if (verdict.kind === 'owned') {
    return verdict.authPath
  }
  if (verdict.kind === 'indeterminate') {
    throw new ClaudeManagedAuthTemporarilyUnavailableError({ cause: verdict.error })
  }
  throw new Error(verdict.reason)
}

export function readClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json'
): string | null {
  const filePath = resolve(managedAuthPath, filename)
  try {
    if (!isOwnedChildFile(managedAuthPath, filePath)) {
      return null
    }
    return readFileSync(filePath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

export function writeClaudeManagedAuthFile(
  managedAuthPath: string,
  filename: '.credentials.json' | 'oauth-account.json',
  contents: string
): void {
  const filePath = resolve(managedAuthPath, filename)
  if (!isOwnedChildFile(managedAuthPath, filePath, true)) {
    throw new Error('Managed Claude auth child file is not owned by Orca.')
  }
  writeFileAtomically(filePath, contents, { mode: 0o600 })
}

function isOwnedChildFile(
  managedAuthPath: string,
  filePath: string,
  allowMissing = false
): boolean {
  try {
    const authStat = lstatSync(managedAuthPath)
    if (!authStat.isDirectory() || authStat.isSymbolicLink()) {
      return false
    }
    const canonicalAuthPath = realpathSync(managedAuthPath)
    let canonicalFilePath: string
    try {
      const fileStat = lstatSync(filePath)
      if (fileStat.isSymbolicLink() || (!fileStat.isFile() && !allowMissing)) {
        return false
      }
      canonicalFilePath = realpathSync(filePath)
    } catch (error) {
      if (!allowMissing || !isDefinitiveAbsence(error)) {
        throw error
      }
      canonicalFilePath = resolve(filePath)
    }
    return (
      pathIsInsideOrEqual(canonicalAuthPath, canonicalFilePath) &&
      canonicalFilePath !== canonicalAuthPath
    )
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}
