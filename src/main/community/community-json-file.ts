import { randomUUID } from 'node:crypto'
import { rm, rename, writeFile } from 'node:fs/promises'
import { hardenExistingSecureFile } from '../../shared/secure-storage/secure-file'

export async function writeCommunityJson(
  path: string,
  value: unknown,
  privateData = false
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    if (privateData) {
      hardenExistingSecureFile(temporary)
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
