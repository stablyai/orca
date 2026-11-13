import { lstat, open, stat, unlink } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import {
  journalLegacyFileIdentity,
  type JournalLegacyFileIdentity
} from './database/journal-legacy-source-receipt'

export const LEGACY_COMPANION_SUFFIXES = ['-wal', '-shm'] as const
export type LegacyCompanionManifest = Partial<
  Record<(typeof LEGACY_COMPANION_SUFFIXES)[number], JournalLegacyFileIdentity>
>
export type LegacyDestinationIdentity = { main: string; wal: string }
export function legacyDestinationMain(filename: string): string {
  const file = lstatSync(filename, { bigint: true })
  if (!file.isFile() || file.nlink !== 1n || file.ino === 0n) {
    throw new Error('invalid journal destination identity')
  }
  return `${file.dev}:${file.ino}`
}
export function legacyDestinationIdentity(filename: string): LegacyDestinationIdentity {
  return { main: legacyDestinationMain(filename), wal: legacyDestinationMain(`${filename}-wal`) }
}

export async function legacyFilePresent(filename: string): Promise<boolean> {
  try {
    await lstat(filename)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function syncLegacyDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  // Ancestors are synced bottom-up so a newly created profile directory is covered too.
  for (;;) {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    const parent = dirname(directory)
    if (parent === directory) {
      return
    }
    directory = parent
  }
}

export async function syncLegacyDestination(directory: string, source: string): Promise<void> {
  const domain = journalDomainDatabasePath(directory)
  const sourceFile = await stat(source, { bigint: true })
  for (const name of [domain, `${domain}-wal`]) {
    const file = await lstat(name, { bigint: true })
    if (
      !file.isFile() ||
      file.dev !== sourceFile.dev ||
      file.ino === sourceFile.ino ||
      file.nlink !== 1n
    ) {
      throw new Error('journal destination volume or identity changed')
    }
  }
  if (process.platform === 'win32') {
    const sourceDevice = sourceFile.dev
    for (const name of [domain, `${domain}-wal`]) {
      const handle = await open(name, 'r+')
      try {
        if ((await handle.stat({ bigint: true })).dev !== sourceDevice) {
          throw new Error('journal destination volume changed')
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  }
  await syncLegacyDirectory(directory)
}

export async function removeLegacyCompanions(
  directory: string,
  filename: string,
  manifest: LegacyCompanionManifest | undefined,
  boundary: () => Promise<boolean>,
  ownsProfile: () => boolean,
  signal: AbortSignal
): Promise<boolean> {
  if (!manifest || !ownsProfile() || signal.aborted) {
    return false
  }
  for (const suffix of LEGACY_COMPANION_SUFFIXES) {
    if (
      !(await boundary()) ||
      !ownsProfile() ||
      (await legacyFilePresent(filename)) ||
      (await legacyFilePresent(`${filename}-journal`))
    ) {
      return false
    }
    const name = filename + suffix
    if (!(await legacyFilePresent(name))) {
      continue
    }
    const expected = manifest[suffix]
    const current = await lstat(name)
    if (
      !current.isFile() ||
      !expected ||
      JSON.stringify(journalLegacyFileIdentity(name)) !== JSON.stringify(expected) ||
      (suffix === '-wal' && expected.size !== '0')
    ) {
      throw new Error('legacy companion changed; retaining it')
    }
    await unlink(name)
  }
  if (
    (await legacyFilePresent(filename)) ||
    (
      await Promise.all(
        LEGACY_COMPANION_SUFFIXES.map((suffix) => legacyFilePresent(filename + suffix))
      )
    ).some(Boolean)
  ) {
    return false
  }
  await syncLegacyDirectory(directory)
  return true
}
