import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const KIMI_MANAGED_HOME_MARKER = '.orca-managed-kimi-home'

function pathsEqual(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

export function assertOwnedKimiManagedHome(args: {
  candidatePath: string
  managedAccountsRoot: string
  accountId: string
  systemKimiHomePath: string
}): string {
  const expectedPath = resolve(args.managedAccountsRoot, args.accountId, 'home')
  if (!existsSync(args.candidatePath)) {
    throw new Error('Managed Kimi home does not exist on disk.')
  }
  const canonicalRoot = realpathSync(args.managedAccountsRoot)
  const canonicalCandidate = realpathSync(args.candidatePath)
  const canonicalExpected = realpathSync(expectedPath)
  const canonicalSystem = existsSync(args.systemKimiHomePath)
    ? realpathSync(args.systemKimiHomePath)
    : resolve(args.systemKimiHomePath)
  if (
    !isInside(canonicalRoot, canonicalCandidate) ||
    !pathsEqual(canonicalCandidate, canonicalExpected)
  ) {
    throw new Error('Managed Kimi home does not match its persisted account ID.')
  }
  if (isInside(canonicalSystem, canonicalCandidate)) {
    throw new Error('Managed Kimi home resolves inside the system Kimi home.')
  }
  const markerPath = join(canonicalCandidate, KIMI_MANAGED_HOME_MARKER)
  if (!existsSync(markerPath) || !lstatSync(markerPath).isFile()) {
    throw new Error('Managed Kimi home is missing its ownership marker.')
  }
  if (readFileSync(markerPath, 'utf-8').trim() !== args.accountId) {
    throw new Error('Managed Kimi home ownership marker does not match its account ID.')
  }
  return canonicalCandidate
}
