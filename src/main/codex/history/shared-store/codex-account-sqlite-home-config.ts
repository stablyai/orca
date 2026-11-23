import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { getGuardedOperationHeldPath } from '../../../filesystem/atomic-file-publication'
import { applyCodexSharedSqliteHome } from '../../configuration/toml/config-toml-shared-sqlite-home'

async function readConfig(configPath: string): Promise<string> {
  try {
    return await readFile(configPath, 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return ''
    }
    throw error
  }
}

async function heldConfigExists(configPath: string): Promise<boolean> {
  try {
    await stat(getGuardedOperationHeldPath(configPath))
    return true
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

/** Orca's sqlite_home line in the home's own config; never the user's ~/.codex config. */
export async function writeSharedSqliteHome(
  accountHome: string,
  sqliteHome: string | null
): Promise<void> {
  const configPath = join(accountHome, 'config.toml')
  // A mirror writing meanwhile wins the race; the line is then applied to its content.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readConfig(configPath)
    if (current === '' && (await heldConfigExists(configPath))) {
      // A mirror write interrupted mid-swap holds the config aside; a new file here would strand
      // it. The next mirror pass puts it back, and this line is applied then.
      throw new Error(`Codex config is held for recovery; sqlite_home not updated in ${configPath}`)
    }
    const next = applyCodexSharedSqliteHome(current, sqliteHome)
    if (next === current) {
      return
    }
    const staged = `${configPath}.${randomUUID()}.tmp`
    // Mirrored MCP environment tokens require owner-only writes.
    await writeFile(staged, next, { mode: 0o600 })
    if ((await readConfig(configPath)) === current) {
      await rename(staged, configPath)
      return
    }
    await unlink(staged)
  }
  throw new Error(`Codex config kept changing; sqlite_home not updated in ${configPath}`)
}
