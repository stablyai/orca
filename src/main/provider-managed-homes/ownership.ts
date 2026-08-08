import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ManagedCliHomeProvider } from '../../shared/managed-account-types'

export const MANAGED_PROVIDER_HOME_MARKER = '.orca-managed-provider-account'

function pathsEqual(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

export function assertOwnedManagedProviderHome(args: {
  provider: ManagedCliHomeProvider
  candidatePath: string
  managedAccountsRoot: string
  accountId: string
  systemHomePath: string
}): string {
  const expectedPath = resolve(args.managedAccountsRoot, args.accountId, 'home')
  if (!existsSync(args.candidatePath)) {
    throw new Error(`Managed ${args.provider} home does not exist on disk.`)
  }
  const candidateInfo = lstatSync(args.candidatePath)
  if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
    throw new Error(`Managed ${args.provider} home must be a directory.`)
  }
  const canonicalRoot = realpathSync(args.managedAccountsRoot)
  const canonicalCandidate = realpathSync(args.candidatePath)
  const canonicalExpected = realpathSync(expectedPath)
  if (
    !isInside(canonicalRoot, canonicalCandidate) ||
    !pathsEqual(canonicalCandidate, canonicalExpected)
  ) {
    throw new Error(`Managed ${args.provider} home does not match its persisted account ID.`)
  }
  const canonicalSystem = existsSync(args.systemHomePath)
    ? realpathSync(args.systemHomePath)
    : resolve(args.systemHomePath)
  const conflictsWithSystemHome =
    args.provider === 'grok'
      ? isInside(canonicalSystem, canonicalCandidate)
      : pathsEqual(canonicalSystem, canonicalCandidate)
  if (conflictsWithSystemHome) {
    throw new Error(`Managed ${args.provider} home resolves inside the system home.`)
  }
  const markerPath = join(canonicalCandidate, MANAGED_PROVIDER_HOME_MARKER)
  if (!existsSync(markerPath) || !lstatSync(markerPath).isFile()) {
    throw new Error(`Managed ${args.provider} home is missing its ownership marker.`)
  }
  if (readFileSync(markerPath, 'utf-8').trim() !== `${args.provider}:${args.accountId}`) {
    throw new Error(`Managed ${args.provider} ownership marker does not match its account ID.`)
  }
  return canonicalCandidate
}
