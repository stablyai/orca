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
import { basename, dirname, join } from 'node:path'

export type NativeHookDestination = {
  path: string
  parent: { dev: string; ino: string }
}

export async function writeHooksJsonAsync(
  configPath: string,
  config: Record<string, unknown>,
  options?: {
    serialized?: string
    privateMode?: boolean
    prepare?: (selectedPath: string) => Promise<void>
    updateConfig?: (original: string | null) => Record<string, unknown> | null
    beforePublish?: (selectedPath: string) => Promise<void>
  }
): Promise<string | null> {
  const link = await lstat(configPath).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  let writePath: string
  if (link) {
    writePath = await realpath(configPath)
  } else {
    let parent = await realpath(dirname(configPath)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    })
    if (parent === null) {
      if (options?.updateConfig && !options.prepare && options.updateConfig(null) === null) {
        return null
      }
      await mkdir(dirname(configPath), { recursive: true })
      parent = await realpath(dirname(configPath))
    }
    writePath = join(parent, basename(configPath))
  }
  await options?.prepare?.(writePath)
  const original = await readFile(writePath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const next = options?.updateConfig ? options.updateConfig(original) : config
  if (next === null) {
    return writePath
  }
  const serialized = options?.serialized ?? `${JSON.stringify(next, null, 2)}\n`
  const beforePublish = async () => {
    if (!options?.beforePublish) {
      return
    }
    await options.beforePublish(writePath)
  }
  if (original === serialized) {
    await beforePublish()
    if (options?.privateMode && process.platform !== 'win32') {
      await chmod(writePath, 0o600)
    }
    return writePath
  }
  await mkdir(dirname(writePath), { recursive: true })
  const mode = options?.privateMode
    ? 0o600
    : original !== null
      ? (await stat(writePath)).mode & 0o777
      : 0o600
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
      if (options?.privateMode && process.platform !== 'win32') {
        await chmod(backupTmp, 0o600)
      }
      await rename(backupTmp, backup)
    }
    await beforePublish()
    await rename(tmp, writePath)
  } finally {
    await Promise.all([rm(tmp, { force: true }), rm(backupTmp, { force: true })])
  }
  return writePath
}
