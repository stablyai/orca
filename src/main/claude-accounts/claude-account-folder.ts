import {
  existsSync,
  lstatSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { resolveClaudeGlobalConfigFile } from '../claude/claude-folder-trust-file'
import { execSecurityCommand } from '../macos-keychain/generic-password'
import { describeClaudeProfile, readClaudeProfileObject } from './claude-profile-paths'
import { claudeConfigDirSpellings, claudeKeychainService } from './keychain'

export type ClaudeFolderLogin = {
  email: string
  organizationUuid: string | null
  organizationName: string | null
}

const text = z
  .string()
  .transform((value) => value.trim() || null)
  .nullish()
  .catch(null)
const oauthAccount = z.object({
  emailAddress: text,
  organizationUuid: text,
  organizationName: text
})

export function claudeStateFile(
  configDir: string | undefined,
  userHome = homedir(),
  exists: (path: string) => boolean = existsSync
): string {
  return resolveClaudeGlobalConfigFile({
    env: { CLAUDE_CONFIG_DIR: configDir },
    homeDir: userHome,
    style: process.platform === 'win32' ? 'win32' : 'posix',
    exists
  })
}

/** Same file as claudeStateFile, without blocking main on the legacy-file check. */
export async function claudeStateFileAsync(
  configDir: string | undefined,
  userHome = homedir()
): Promise<string> {
  const legacy = claudeStateFile(configDir, userHome, () => true)
  return (await stat(legacy).catch(() => null))
    ? legacy
    : claudeStateFile(configDir, userHome, () => false)
}

// Cache large, frequently rewritten state files across account-list refreshes.
const logins = new Map<
  string,
  { mtimeMs: number; size: number; readAt: number; login: ClaudeFolderLogin | null }
>()

/** Missing organization IDs permit an email-only match. */
export function isSameClaudeLogin(
  left: { email: string; organizationUuid?: string | null },
  right: { email: string; organizationUuid?: string | null }
): boolean {
  return (
    left.email.trim().toLowerCase() === right.email.trim().toLowerCase() &&
    (!left.organizationUuid ||
      !right.organizationUuid ||
      left.organizationUuid === right.organizationUuid)
  )
}

export function claudeStateLogin(state: Record<string, unknown>): ClaudeFolderLogin | null {
  const parsed = oauthAccount.safeParse(state.oauthAccount)
  const email = parsed.success ? parsed.data.emailAddress : null
  return parsed.success && email
    ? {
        email,
        organizationUuid: parsed.data.organizationUuid ?? null,
        organizationName: parsed.data.organizationName ?? null
      }
    : null
}

/** `maxAgeMs` also skips stat calls while the cached login is fresh. */
export function readClaudeFolderLogin(stateFile: string, maxAgeMs = 0): ClaudeFolderLogin | null {
  const recent = logins.get(stateFile)
  if (recent && Date.now() - recent.readAt < maxAgeMs) {
    return recent.login
  }
  let stat: { mtimeMs: number; size: number }
  try {
    stat = statSync(stateFile)
  } catch {
    logins.delete(stateFile)
    return null
  }
  if (recent?.mtimeMs === stat.mtimeMs && recent.size === stat.size) {
    recent.readAt = Date.now()
    return recent.login
  }
  const read = readClaudeProfileObject(stateFile)
  const login = read.kind === 'present' ? claudeStateLogin(read.value) : null
  logins.set(stateFile, { mtimeMs: stat.mtimeMs, size: stat.size, readAt: Date.now(), login })
  return login
}

// Concurrent chat reads of one state-file revision share a single read and parse.
const pendingLogins = new Map<
  string,
  { mtimeMs: number; size: number; login: Promise<ClaudeFolderLogin | null> }
>()

/** Avoid blocking main on state files across WSL shares. */
export async function readClaudeFolderLoginAsync(
  stateFile: string
): Promise<ClaudeFolderLogin | null> {
  const current = await stat(stateFile).catch(() => null)
  if (!current) {
    logins.delete(stateFile)
    pendingLogins.delete(stateFile)
    return null
  }
  const recent = logins.get(stateFile)
  if (recent?.mtimeMs === current.mtimeMs && recent.size === current.size) {
    return recent.login
  }
  const pending = pendingLogins.get(stateFile)
  if (pending?.mtimeMs === current.mtimeMs && pending.size === current.size) {
    return pending.login
  }
  const read = { mtimeMs: current.mtimeMs, size: current.size, login: readStateLogin(stateFile) }
  pendingLogins.set(stateFile, read)
  const login = await read.login
  // A read superseded by a newer revision (or a deleted file) must not repopulate the cache.
  if (pendingLogins.get(stateFile) === read) {
    pendingLogins.delete(stateFile)
    logins.set(stateFile, { mtimeMs: read.mtimeMs, size: read.size, readAt: Date.now(), login })
  }
  return login
}

async function readStateLogin(stateFile: string): Promise<ClaudeFolderLogin | null> {
  try {
    const state: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      return claudeStateLogin(Object.fromEntries(Object.entries(state)))
    }
  } catch {
    // Treat unreadable state as signed out.
  }
  return null
}

/** Removes current profiles only; legacy `claude-accounts/` folders stay untouched. */
export async function removeClaudeAccountFolder(
  dataRoot: string,
  accountId: string
): Promise<void> {
  const { home } = describeClaudeProfile(dataRoot, accountId, {
    executionHostId: 'local',
    runtime: 'host'
  })
  if (process.platform === 'darwin') {
    for (const spelling of claudeConfigDirSpellings(home, homedir())) {
      // Each delete removes only one Keychain item for this service.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const deleted = await execSecurityCommand([
          'delete-generic-password',
          '-s',
          claudeKeychainService(spelling)
        ]).then(
          () => true,
          () => false
        )
        if (!deleted) {
          break
        }
      }
    }
  }
  const folder = dirname(home)
  unlinkLinks(folder)
  rmSync(folder, { recursive: true, force: true })
}

// Unlink shared history before recursive deletion can follow Windows junctions.
function unlinkLinks(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    // Entries may vanish after listing.
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat) {
      continue
    }
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(path)
      } catch {
        // A Windows directory link is removed as a directory.
        rmdirSync(path)
      }
    } else if (stat.isDirectory()) {
      unlinkLinks(path)
    }
  }
}
