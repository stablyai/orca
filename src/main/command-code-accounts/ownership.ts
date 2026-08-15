import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const COMMAND_CODE_ACCOUNT_MARKER = '.orca-managed-command-code-account'

function pathsEqual(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

export function assertOwnedCommandCodeAuth(args: {
  candidatePath: string
  managedAccountsRoot: string
  accountId: string
}): string {
  const expectedPath = resolve(args.managedAccountsRoot, args.accountId, 'auth.json')
  if (!existsSync(args.candidatePath)) {
    throw new Error('Managed Command Code credential does not exist on disk.')
  }
  const candidateInfo = lstatSync(args.candidatePath)
  if (!candidateInfo.isFile() || candidateInfo.isSymbolicLink()) {
    throw new Error('Managed Command Code credential must be a regular file.')
  }
  const canonicalRoot = realpathSync(args.managedAccountsRoot)
  const canonicalCandidate = realpathSync(args.candidatePath)
  const canonicalExpected = realpathSync(expectedPath)
  if (
    !isInside(canonicalRoot, canonicalCandidate) ||
    !pathsEqual(canonicalCandidate, canonicalExpected)
  ) {
    throw new Error('Managed Command Code credential does not match its persisted account ID.')
  }
  const systemDirectory = join(homedir(), '.commandcode')
  const canonicalSystemDirectory = existsSync(systemDirectory)
    ? realpathSync(systemDirectory)
    : resolve(systemDirectory)
  if (isInside(canonicalSystemDirectory, canonicalCandidate)) {
    throw new Error('Managed Command Code credential resolves inside the system home.')
  }
  const markerPath = join(canonicalCandidate, '..', COMMAND_CODE_ACCOUNT_MARKER)
  if (!existsSync(markerPath) || !lstatSync(markerPath).isFile()) {
    throw new Error('Managed Command Code credential is missing its ownership marker.')
  }
  if (readFileSync(markerPath, 'utf-8').trim() !== args.accountId) {
    throw new Error('Managed Command Code ownership marker does not match its account ID.')
  }
  return canonicalCandidate
}
