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

/** Claude's state file for a config folder; undefined is `~/.claude`, whose file sits in home. */
export function claudeStateFile(configDir: string | undefined, userHome = homedir()): string {
  return resolveClaudeGlobalConfigFile({
    env: { CLAUDE_CONFIG_DIR: configDir },
    homeDir: userHome,
    style: process.platform === 'win32' ? 'win32' : 'posix',
    exists: existsSync
  })
}

// Why memoized: a state file grows with history and the account list is read on every refresh.
const logins = new Map<
  string,
  { mtimeMs: number; size: number; readAt: number; login: ClaudeFolderLogin | null }
>()

/** Whether two logins name one account: the same email, and the same organization when both
 *  name one, so one email in two organizations stays two accounts. */
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

/** The login parsed Claude state names; null before Claude finishes a sign-in. */
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

/**
 * The login a Claude state file names; null when signed out (superset U/profiles.ts:121-137).
 * `maxAgeMs` reuses a recent answer without a stat, for a file Claude rewrites constantly.
 */
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

/** readClaudeFolderLogin without blocking, for a state file across a WSL share. */
export async function readClaudeFolderLoginAsync(
  stateFile: string
): Promise<ClaudeFolderLogin | null> {
  const current = await stat(stateFile).catch(() => null)
  if (!current) {
    logins.delete(stateFile)
    return null
  }
  const recent = logins.get(stateFile)
  if (recent?.mtimeMs === current.mtimeMs && recent.size === current.size) {
    return recent.login
  }
  let login: ClaudeFolderLogin | null = null
  try {
    const state: unknown = JSON.parse(await readFile(stateFile, 'utf8'))
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      login = claudeStateLogin(Object.fromEntries(Object.entries(state)))
    }
  } catch {
    // Unreadable reads as signed out, as on the host.
  }
  logins.set(stateFile, {
    mtimeMs: current.mtimeMs,
    size: current.size,
    readAt: Date.now(),
    login
  })
  return login
}

/**
 * Deletes a host account's folder and, on macOS, the Keychain items Claude keyed to it
 * (superset profile-remove.ts). Only `claude-profiles/<id>` is reachable from an id, so an
 * older Orca's `claude-accounts/` folders are never touched.
 */
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
      // Why a loop: items are filed per Keychain account name, and each delete removes one.
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

// Why first: history is linked into ~/.claude, and a recursive delete that followed a Windows
// junction would delete the user's own history.
function unlinkLinks(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    // Why no throw: an entry may vanish between the listing and the stat.
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
