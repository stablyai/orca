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

/** Caller-relative `executionHostId` routes calls but must not be persisted. */
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

/** Use execution-host paths; pass the same normalized home at login and launch for Keychain identity. */
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

// Persist host-local identity in a stable key order for comparison.
function ownershipRecord(
  version: unknown,
  accountId: unknown,
  runtime: unknown,
  distro: unknown
): string {
  return JSON.stringify({ version, accountId, runtime, distro })
}

function comparableOwnershipRecord(
  version: unknown,
  accountId: unknown,
  runtime: unknown,
  distro: unknown
): string {
  return ownershipRecord(
    version,
    accountId,
    runtime,
    runtime === 'wsl' && typeof distro === 'string' ? distro.trim().toLowerCase() : distro
  )
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
  return comparableOwnershipRecord(version, accountId, runtime, distro)
}

// Setup writes this marker only after completing successfully.
export function claudeProfileMarkerPath(profile: ClaudeProfileDescriptor): string {
  const path = profile.target.runtime === 'wsl' ? hostPath.posix : hostPath
  return path.join(path.dirname(profile.home), 'profile.json')
}

/** Validate ownership before creation; the returned marker writer must run last during setup. */
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
  if (
    marker !== null &&
    marker !==
      comparableOwnershipRecord(profile.version, profile.accountId, profile.target.runtime, distro)
  ) {
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

/** Resolve ancestor links and on-disk casing even for paths that do not exist yet. */
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

/** Profiles and default homes must not overlap in either direction. */
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

export function readUserClaudeConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  const user = readUserClaudeConfigDirAsSet(env)
  return user === undefined ? undefined : resolve(user.trim())
}

/** Preserve literal spelling for Keychain identity and shell rc comparisons. */
export function readUserClaudeConfigDirAsSet(env: NodeJS.ProcessEnv): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR
  const injected = env[CLAUDE_INJECTED_CONFIG_DIR_ENV]?.trim()
  if (!configDir?.trim()) {
    return undefined
  }
  if (injected && resolve(injected) === resolve(configDir.trim())) {
    return env[CLAUDE_USER_CONFIG_DIR_ENV]?.trim() ? env[CLAUDE_USER_CONFIG_DIR_ENV] : undefined
  }
  return configDir
}

export function resolveClaudeDefaultHome(userHome: string, userConfigDir?: string): string {
  return userConfigDir ?? join(userHome, '.claude')
}
