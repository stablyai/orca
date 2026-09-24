import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  deleteActiveClaudeKeychainCredentialsStrict,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials
} from './keychain'

/**
 * macOS credential staging for a Claude launched on a non-active managed account.
 *
 * Claude reads the Keychain item scoped to its CLAUDE_CONFIG_DIR, never Orca's managed item, so a
 * pinned launch copies the managed blob into that scoped item and takes it back when the last
 * pinned PTY exits. Refresh tokens are single-use, so while the scoped copy is live it is the only
 * store allowed to refresh; the marker records what was seeded so the read-back can tell a Claude
 * refresh (adopt) from a re-auth that happened in between (the managed store wins).
 *
 * Only the scoped item is touched here. The legacy unscoped `Claude Code-credentials` item belongs
 * to the host's active account and every call passes a config dir, so none can reach it.
 */
const PINNED_KEYCHAIN_SEED_MARKER = '.orca-pinned-keychain-seed'

// Why: a hot-path cache for the usage fetcher; the marker file is the source of truth.
const pendingSeedAccountIds = new Set<string>()

export function hashClaudeCredentialsJson(credentialsJson: string): string {
  return createHash('sha256').update(credentialsJson).digest('hex')
}

export function readPinnedClaudeSeedMarker(configDir: string): string | null {
  const markerPath = join(configDir, PINNED_KEYCHAIN_SEED_MARKER)
  try {
    if (!existsSync(markerPath) || !lstatSync(markerPath).isFile()) {
      return null
    }
    return readFileSync(markerPath, 'utf-8').trim() || null
  } catch {
    return null
  }
}

/** True while a seeded scoped item may hold a newer token than the managed store. */
export function hasPendingPinnedClaudeSeed(accountId: string): boolean {
  return pendingSeedAccountIds.has(accountId)
}

/** Loads markers left by a previous run so the crash recovery happens before any refresh. */
export function notePinnedClaudeSeedMarker(accountId: string, configDir: string): void {
  if (readPinnedClaudeSeedMarker(configDir) !== null) {
    pendingSeedAccountIds.add(accountId)
  }
}

export function listPendingPinnedClaudeSeedAccountIds(): string[] {
  return [...pendingSeedAccountIds]
}

export function clearPendingPinnedClaudeSeed(accountId: string): void {
  pendingSeedAccountIds.delete(accountId)
}

export async function seedPinnedClaudeKeychainCredentials(args: {
  accountId: string
  configDir: string
  credentialsJson: string
}): Promise<void> {
  await writeActiveClaudeKeychainCredentials(args.credentialsJson, args.configDir)
  try {
    // A hash, never the blob: the marker sits in a plain file next to the config.
    writeFileAtomically(
      join(args.configDir, PINNED_KEYCHAIN_SEED_MARKER),
      `${hashClaudeCredentialsJson(args.credentialsJson)}\n`,
      { mode: 0o600 }
    )
  } catch (error) {
    // Why: an unmarked scoped copy could never be read back, so do not leave one live.
    await deleteActiveClaudeKeychainCredentialsStrict(args.configDir).catch(() => {})
    throw error
  }
  pendingSeedAccountIds.add(args.accountId)
}

export async function readPinnedClaudeKeychainCredentials(
  configDir: string
): Promise<string | null> {
  return readActiveClaudeKeychainCredentialsStrict(configDir)
}

/** Deletes the scoped copy first so a failed delete keeps the marker and is retried. */
export async function clearPinnedClaudeKeychainCredentials(
  accountId: string,
  configDir: string
): Promise<void> {
  await deleteActiveClaudeKeychainCredentialsStrict(configDir)
  rmSync(join(configDir, PINNED_KEYCHAIN_SEED_MARKER), { force: true })
  pendingSeedAccountIds.delete(accountId)
}

export const _internals = {
  reset(): void {
    pendingSeedAccountIds.clear()
  }
}
