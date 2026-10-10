import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import * as hostPath from 'node:path'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { ExecutionHostId } from '../../shared/execution-host'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { ClaudeProfileSurfaceError } from './claude-profile-report'

/** `executionHostId` routes calls to the host; it is the caller's view, so it is never persisted. */
export type ClaudeProfileTarget =
  | { executionHostId: ExecutionHostId; runtime: 'host' }
  | { executionHostId: ExecutionHostId; runtime: 'wsl'; distro: string }

export type ClaudeProfileDescriptor = {
  version: 1
  accountId: string
  target: ClaudeProfileTarget
  home: string
}

export type ClaudeProfileRead<T> =
  | { kind: 'present'; value: T }
  | { kind: 'absent' }
  | { kind: 'unavailable'; error: unknown }

function isProfileObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readClaudeProfileObject(file: string): ClaudeProfileRead<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isProfileObject(value)) {
      throw new Error('Expected a profile JSON object')
    }
    return { kind: 'present', value }
  } catch (error) {
    return isDefinitiveAbsence(error) ? { kind: 'absent' } : { kind: 'unavailable', error }
  }
}

/**
 * dataRoot belongs to the execution host: for WSL it is the guest's Linux data root. `home` is the
 * one spelling (absolute, normalized, no trailing separator) sign-in and launch must pass as
 * CLAUDE_CONFIG_DIR: Claude names the profile's Keychain entry from that exact text.
 */
export function describeClaudeProfile(
  dataRoot: string,
  accountId: string,
  target: ClaudeProfileTarget
): ClaudeProfileDescriptor {
  const path = target.runtime === 'wsl' ? hostPath.posix : hostPath
  if (!path.isAbsolute(dataRoot) || !/^[a-zA-Z0-9_-]+$/.test(accountId)) {
    throw new Error('Invalid Claude profile location')
  }
  if (!target.executionHostId || (target.runtime === 'wsl' && !target.distro)) {
    throw new Error('Claude profile requires an execution target')
  }
  return {
    version: 1,
    accountId,
    target,
    home: path.join(dataRoot, 'claude-profiles', accountId, 'home')
  }
}

// Host-local facts only, in a fixed key order: the marker sits on the execution host's own disk.
function ownershipRecord(
  version: unknown,
  accountId: unknown,
  runtime: unknown,
  distro: unknown
): string {
  return JSON.stringify({ version, accountId, runtime, distro })
}

function readOwnershipMarker(file: string): string | null {
  try {
    if (!lstatSync(file).isFile()) {
      throw new ClaudeProfileSurfaceError('invalid-profile', 'Claude profile marker is not a file')
    }
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
  const marker = readClaudeProfileObject(file)
  if (marker.kind !== 'present') {
    throw new ClaudeProfileSurfaceError('unreadable', 'Claude profile marker is unreadable')
  }
  const { version, accountId, runtime, distro } = marker.value
  return ownershipRecord(version, accountId, runtime, distro)
}

// Written when a first setup finishes, so its absence means no setup has finished here yet.
export function claudeProfileMarkerPath(profile: ClaudeProfileDescriptor): string {
  const path = profile.target.runtime === 'wsl' ? hostPath.posix : hostPath
  return path.join(path.dirname(profile.home), 'profile.json')
}

/**
 * The only gate before writing into a profile: namespace, containment, no linked components,
 * outside Claude's default homes, and an ownership marker beside the home. Refuses before creating
 * anything. Returns the step that writes the marker, which setup runs last.
 */
export function prepareClaudeProfileDirectory(
  dataRoot: string,
  profile: ClaudeProfileDescriptor,
  userHome: string,
  userConfigDir?: string
): () => void {
  let expected: ClaudeProfileDescriptor
  try {
    expected = describeClaudeProfile(dataRoot, profile.accountId, profile.target)
  } catch (error) {
    throw new ClaudeProfileSurfaceError('invalid-profile', String(error))
  }
  if (profile.version !== 1 || profile.home !== expected.home) {
    throw new ClaudeProfileSurfaceError(
      'invalid-profile',
      'Claude profile does not match its account namespace'
    )
  }
  assertClaudeProfileDescendant(dataRoot, profile.home)
  assertOutsideDefaultClaudeHomes(profile.home, userHome, userConfigDir)
  const markerPath = claudeProfileMarkerPath(profile)
  const distro = profile.target.runtime === 'wsl' ? profile.target.distro : undefined
  const record = ownershipRecord(profile.version, profile.accountId, profile.target.runtime, distro)
  const marker = readOwnershipMarker(markerPath)
  if (marker !== null && marker !== record) {
    throw new ClaudeProfileSurfaceError(
      'invalid-profile',
      'Claude profile belongs to another account or target'
    )
  }
  mkdirSync(profile.home, { recursive: true, mode: 0o700 })
  return () => {
    if (marker === null) {
      writeFileAtomically(markerPath, `${record}\n`, { mode: 0o600 })
    }
  }
}

function assertClaudeProfileDescendant(root: string, destination: string): void {
  const suffix = relative(resolve(root), resolve(destination))
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new ClaudeProfileSurfaceError(
      'invalid-profile',
      'Claude profile destination escapes its root'
    )
  }
  // The caller owns root; links below it must not redirect profile writes.
  let cursor = resolve(root)
  for (const part of suffix.split(sep)) {
    cursor = join(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new ClaudeProfileSurfaceError(
          'invalid-profile',
          'Claude profile path contains a link'
        )
      }
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }
}

/**
 * Resolves links in the deepest existing ancestor so a not-yet-created path cannot hide behind one;
 * the native call also returns on-disk case, so a case-only alias compares equal.
 */
function canonicalPath(file: string): string {
  const resolved = resolve(file)
  try {
    return realpathSync.native(resolved)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    const parent = dirname(resolved)
    return parent === resolved ? resolved : join(canonicalPath(parent), basename(resolved))
  }
}

function assertDistinctClaudeProfile(profile: string, defaultHome: string): void {
  const left = canonicalPath(profile)
  const right = canonicalPath(defaultHome)
  for (const [root, destination] of [
    [left, right],
    [right, left]
  ] as const) {
    const suffix = relative(root, destination)
    if (!suffix || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))) {
      throw new ClaudeProfileSurfaceError(
        'invalid-profile',
        'Claude profile and default home must be separate directories'
      )
    }
  }
}

/** Claude's default homes: a profile may never be, contain, or sit inside one. */
function assertOutsideDefaultClaudeHomes(
  profileHome: string,
  userHome: string,
  userConfigDir?: string
): void {
  assertDistinctClaudeProfile(profileHome, join(userHome, '.claude'))
  assertDistinctClaudeProfile(profileHome, join(userHome, '.config', 'claude'))
  if (userConfigDir !== undefined) {
    assertDistinctClaudeProfile(profileHome, userConfigDir)
  }
}

/** The user's own CLAUDE_CONFIG_DIR (their System default), or undefined for `~/.claude`. */
export function readUserClaudeConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  const injected = env[CLAUDE_INJECTED_CONFIG_DIR_ENV]?.trim()
  if (!configDir) {
    return undefined
  }
  if (injected && resolve(injected) === resolve(configDir)) {
    // Why: an outer Orca's injected value carries the user's own beside it.
    const user = env[CLAUDE_USER_CONFIG_DIR_ENV]?.trim()
    return user ? resolve(user) : undefined
  }
  return resolve(configDir)
}

/** The folder profiles share from: the user's own CLAUDE_CONFIG_DIR, else `~/.claude`. */
export function resolveClaudeDefaultHome(userHome: string, userConfigDir?: string): string {
  return userConfigDir ?? join(userHome, '.claude')
}
