import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
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

/** Orca's sqlite_home line in the home's own config; never the user's ~/.codex config. */
export async function writeSharedSqliteHome(
  accountHome: string,
  sqliteHome: string | null
): Promise<void> {
  const configPath = join(accountHome, 'config.toml')
  // A mirror writing meanwhile wins the race; the line is then applied to its content.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readConfig(configPath)
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
