import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function canonicalTerminalClaimDatabase(databaseFile: string): Promise<string> {
  try {
    return await realpath(databaseFile)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error
    }
    return join(await realpath(dirname(databaseFile)), basename(databaseFile))
  }
}
