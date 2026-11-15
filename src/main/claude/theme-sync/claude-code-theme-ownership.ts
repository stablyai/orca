import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import {
  isPlainObject,
  parseHooksJsonText
} from '../../agent-hooks/installation/configuration/hooks-json-read'
import { writeHooksJsonAsync } from '../../agent-hooks/installation/configuration/hooks-json-write-async'
import { withManagedHookInstallLock } from '../../agent-hooks/installation/locking/managed-hook-install-lock'

/** What Orca replaced in one config dir's settings.json, so turning the sync off can put it back. */
export type ClaudeThemeOwnership = {
  /** The Orca profile (userData path) that took over; only it restores, so builds with different settings do not fight. */
  owner: string
  /** null when settings.json had no theme. */
  previousTheme: string | null
  /** The user picked another theme after Orca's; Orca stops writing it. */
  userChangedTheme?: true
}

type OwnershipByConfigDir = Map<string, ClaudeThemeOwnership>

// Why under ~/.orca, not userData: every Orca build on this machine must agree on what it replaced.
function ownershipPath(): string {
  return join(homedir(), '.orca', 'claude-theme-sync.json')
}

/** Every config dir Orca took over, keyed by path; null when the record exists but cannot be read. */
export async function readClaudeThemeOwnership(): Promise<OwnershipByConfigDir | null> {
  let raw: string
  try {
    raw = await readFile(ownershipPath(), 'utf-8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? new Map() : null
  }
  const parsed = parseHooksJsonText(raw)
  if (!parsed) {
    return null
  }
  const owned: OwnershipByConfigDir = new Map()
  for (const [dir, entry] of Object.entries(parsed)) {
    const previous = isPlainObject(entry) ? entry.previousTheme : undefined
    if (
      isPlainObject(entry) &&
      typeof entry.owner === 'string' &&
      (typeof previous === 'string' || previous === null)
    ) {
      owned.set(dir, {
        owner: entry.owner,
        previousTheme: previous,
        ...(entry.userChangedTheme === true ? { userChangedTheme: true } : {})
      })
    }
  }
  return owned
}

/** One config dir's record, read and written under Orca's managed-hook lock. */
export type ClaudeThemeOwnershipSlot = {
  entry: ClaudeThemeOwnership | undefined
  /** Saves `next` (undefined removes it) before the caller goes on. */
  save: (next: ClaudeThemeOwnership | undefined) => Promise<void>
}

/**
 * Runs `edit` with a fresh read of `configDir`'s record under Orca's cross-process managed-hook lock,
 * so two Orca builds never drop each other's entries or edit settings.json for the theme at once.
 */
export async function withClaudeThemeOwnership<T>(
  configDir: string,
  edit: (slot: ClaudeThemeOwnershipSlot) => Promise<T>
): Promise<T> {
  return await withManagedHookInstallLock(homedir(), undefined, async () => {
    const owned = await readClaudeThemeOwnership()
    if (!owned) {
      throw new Error(`Cannot read ${ownershipPath()}`)
    }
    return await edit({
      entry: owned.get(configDir),
      save: async (next) => {
        if (next) {
          owned.set(configDir, next)
        } else if (!owned.delete(configDir)) {
          return
        }
        await writeHooksJsonAsync(ownershipPath(), Object.fromEntries(owned))
      }
    })
  })
}

/** Holds the same lock as record edits, so a reload retry never republishes a file another Orca just replaced. */
export async function withClaudeThemeFileLock<T>(run: () => Promise<T>): Promise<T> {
  return await withManagedHookInstallLock(homedir(), undefined, run)
}
