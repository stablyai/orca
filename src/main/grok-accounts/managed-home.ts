import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, normalize, resolve, sep, win32 } from 'node:path'
import { app } from 'electron'
import type { GrokManagedAccount } from '../../shared/types'

const MANAGED_HOME_MARKER = '.orca-managed-grok-home'

export function createGrokManagedHome(accountId: string): string {
  const managedHomePath = getExpectedGrokManagedHomePath(accountId)
  mkdirSync(managedHomePath, { recursive: true })
  writeGrokManagedHomeMarker(managedHomePath, accountId)
  return assertGrokManagedHomePath(managedHomePath, accountId)
}

export function assertGrokManagedHomePath(managedHomePath: string, accountId: string): string {
  const root = realpathSync(getGrokManagedAccountsRoot())
  const realHome = realpathSync(managedHomePath)
  if (!isPathInside(realHome, root)) {
    throw new Error('Refusing to use a Grok account home outside Orca managed storage.')
  }
  const marker = readFileSync(join(realHome, MANAGED_HOME_MARKER), 'utf-8').trim()
  if (marker !== accountId) {
    throw new Error('Refusing to use a Grok account home without Orca ownership marker.')
  }
  return realHome
}

export function ensureGrokManagedHomeForReauthentication(account: GrokManagedAccount): string {
  const expectedManagedHomePath = getExpectedGrokManagedHomePath(account.id)
  if (!samePath(account.managedHomePath, expectedManagedHomePath)) {
    throw new Error('Grok account home is missing or no longer managed by Orca.')
  }
  if (existsSync(account.managedHomePath)) {
    try {
      return assertGrokManagedHomePath(account.managedHomePath, account.id)
    } catch {
      // Why: reauth may repair a lost marker, but must not bless symlink
      // escapes or non-managed paths just because the settings path is expected.
      return repairExpectedGrokManagedHomeMarker(account.managedHomePath, account.id)
    }
  }
  return createGrokManagedHome(account.id)
}

export function safeRemoveGrokManagedHome(managedHomePath: string, accountId: string): void {
  try {
    if (!existsSync(managedHomePath)) {
      return
    }
    const trustedHome = assertGrokManagedHomePath(managedHomePath, accountId)
    const parentDir = resolve(trustedHome, '..')
    const root = realpathSync(getGrokManagedAccountsRoot())
    if (isPathInside(parentDir, root)) {
      rmSync(parentDir, { recursive: true, force: true })
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function getExpectedGrokManagedHomePath(accountId: string): string {
  return join(getGrokManagedAccountsRoot(), accountId, 'home')
}

function getGrokManagedAccountsRoot(): string {
  const root = join(app.getPath('userData'), 'grok-accounts')
  mkdirSync(root, { recursive: true })
  return root
}

function writeGrokManagedHomeMarker(managedHomePath: string, accountId: string): void {
  // Why: managed account removal is destructive; this marker proves the
  // target home was created by Orca before recursive cleanup.
  writeFileSync(join(managedHomePath, MANAGED_HOME_MARKER), `${accountId}\n`, 'utf-8')
}

function repairExpectedGrokManagedHomeMarker(managedHomePath: string, accountId: string): string {
  const stats = lstatSync(managedHomePath)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Grok account home is missing or no longer managed by Orca.')
  }
  const root = realpathSync(getGrokManagedAccountsRoot())
  const realHome = realpathSync(managedHomePath)
  if (!isPathInside(realHome, root)) {
    throw new Error('Refusing to use a Grok account home outside Orca managed storage.')
  }
  writeGrokManagedHomeMarker(managedHomePath, accountId)
  return assertGrokManagedHomePath(managedHomePath, accountId)
}

function pathComparisonValue(value: string): string {
  return process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value)
}

function samePath(left: string, right: string): boolean {
  return pathComparisonValue(resolve(left)) === pathComparisonValue(resolve(right))
}

function isPathInside(candidate: string, root: string): boolean {
  return isGrokManagedPathInsideRoot(candidate, root)
}

export function isGrokManagedPathInsideRoot(
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const separator = platform === 'win32' ? win32.sep : sep
  const normalizedRoot = normalizeManagedPathForPlatform(root, platform)
  const normalizedCandidate = normalizeManagedPathForPlatform(candidate, platform)
  if (!normalizedRoot || normalizedCandidate === normalizedRoot) {
    return false
  }
  return normalizedCandidate.startsWith(
    normalizedRoot.endsWith(separator) ? normalizedRoot : `${normalizedRoot}${separator}`
  )
}

function normalizeManagedPathForPlatform(value: string, platform: NodeJS.Platform): string {
  const normalized = platform === 'win32' ? win32.normalize(value) : normalize(value)
  const comparable = platform === 'win32' ? normalized.toLowerCase() : normalized
  if (comparable.length > 1 && comparable.endsWith(platform === 'win32' ? win32.sep : sep)) {
    return comparable.slice(0, -1)
  }
  return comparable
}
