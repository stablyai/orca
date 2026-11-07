import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { isPlainObject, parseHooksJsonText } from '../../agent-hooks/hooks-json-read'
import { writeHooksJsonAsync } from '../../agent-hooks/hooks-json-write-async'

/** What Orca replaced in one config dir's settings.json, so turning the sync off can put it back. */
export type ClaudeThemeOwnership = {
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
    if (isPlainObject(entry) && (typeof previous === 'string' || previous === null)) {
      owned.set(dir, {
        previousTheme: previous,
        ...(entry.userChangedTheme === true ? { userChangedTheme: true } : {})
      })
    }
  }
  return owned
}

/** Rereads before writing so another Orca build's entries for other dirs survive. */
export async function recordClaudeThemeOwnership(
  configDir: string,
  entry: ClaudeThemeOwnership | undefined
): Promise<void> {
  const owned = await readClaudeThemeOwnership()
  if (!owned) {
    throw new Error(`Cannot read ${ownershipPath()}`)
  }
  if (entry) {
    owned.set(configDir, entry)
  } else if (!owned.delete(configDir)) {
    return
  }
  await writeHooksJsonAsync(ownershipPath(), Object.fromEntries(owned))
}
