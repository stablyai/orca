import { randomUUID } from 'node:crypto'
import {
  lstat,
  realpath,
  mkdir,
  readFile,
  writeFile,
  stat,
  chmod,
  copyFile,
  rename,
  rm
} from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeHooksJsonAsync(
  configPath: string,
  config: Record<string, unknown>,
  options?: { serialized?: string }
): Promise<void> {
  const link = await lstat(configPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const writePath = link?.isSymbolicLink() ? await realpath(configPath) : configPath
  const serialized = options?.serialized ?? `${JSON.stringify(config, null, 2)}\n`
  const original = await readFile(writePath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (original === serialized) {
    return
  }
  await mkdir(dirname(writePath), { recursive: true })
  const mode = original !== null ? (await stat(writePath)).mode & 0o777 : 0o600
  const tmp = `${writePath}.${randomUUID()}.tmp`
  const backup = `${writePath}.bak`
  const backupTmp = `${backup}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, serialized, { mode, flag: 'wx' })
    if (process.platform !== 'win32') {
      await chmod(tmp, mode)
    }
    if (original !== null) {
      const backupLink = await lstat(backup).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return null
        }
        throw error
      })
      if (backupLink?.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlinked backup: ${backup}`)
      }
      await copyFile(writePath, backupTmp)
      await rename(backupTmp, backup)
    }
    await rename(tmp, writePath)
  } finally {
    await Promise.all([rm(tmp, { force: true }), rm(backupTmp, { force: true })])
  }
}
