import { lstat, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'

export type LegacyDestinationIdentity = { main: string; wal: string }

export function legacyDestinationFileIdentity(file: BigIntStats): string {
  if (!file.isFile() || file.nlink !== 1n || file.ino === 0n) {
    throw new Error('invalid journal destination identity')
  }
  return `${file.dev}:${file.ino}`
}

export async function legacyDestinationMain(filename: string): Promise<string> {
  return legacyDestinationFileIdentity(await lstat(filename, { bigint: true }))
}

export async function legacyDestinationIdentity(
  filename: string
): Promise<LegacyDestinationIdentity> {
  const [main, wal] = await Promise.all([
    legacyDestinationMain(filename),
    legacyDestinationMain(`${filename}-wal`)
  ])
  return { main, wal }
}

export async function legacyFilePresent(filename: string): Promise<boolean> {
  return (await legacyFileStat(filename)) !== undefined
}

async function legacyFileStat(filename: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(filename, { bigint: true })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** A WAL or SHM file is still beside the original's name. */
export async function legacyCompanionsPresent(filename: string): Promise<boolean> {
  for (const suffix of ['-wal', '-shm'] as const) {
    if ((await legacyFileStat(filename + suffix))?.isFile()) {
      return true
    }
  }
  return false
}

/**
 * A removal stopped after the main file leaves its WAL and SHM. Without a main file SQLite never
 * reads them. An empty WAL and a regular SHM go; a WAL holding frames goes only when it is the
 * one the retirement proved absorbed (`absorbedWal`, its size, inode and mtime). Anything else
 * stays.
 */
export async function removeLeftoverLegacyCompanions(
  filename: string,
  absorbedWal?: { size: string; ino?: string; mtimeNs?: string }
): Promise<void> {
  if ((await legacyFilePresent(filename)) || (await legacyFilePresent(`${filename}-journal`))) {
    return
  }
  for (const suffix of ['-wal', '-shm'] as const) {
    const file = await legacyFileStat(filename + suffix)
    if (!file?.isFile()) {
      continue
    }
    if (
      suffix === '-wal' &&
      file.size !== 0n &&
      !(
        absorbedWal &&
        absorbedWal.size === String(file.size) &&
        absorbedWal.ino === String(file.ino) &&
        absorbedWal.mtimeNs === String(file.mtimeNs)
      )
    ) {
      continue
    }
    try {
      await unlink(filename + suffix)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
  }
}
