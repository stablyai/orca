import type { acquireJournalLegacyFileLock } from './journal-legacy-file-lock'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import { lstat, open, stat, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname } from 'node:path'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import {
  journalLegacyFileIdentityFromStat,
  type JournalLegacyFileIdentity
} from './database/journal-legacy-source-receipt'

export const LEGACY_COMPANION_SUFFIXES = ['-wal', '-shm'] as const
export type LegacyCompanionManifest = Partial<
  Record<(typeof LEGACY_COMPANION_SUFFIXES)[number], JournalLegacyFileIdentity>
>
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
    const current = await lstat(name, { bigint: true })
    if (
      !current.isFile() ||
      !expected ||
      JSON.stringify(journalLegacyFileIdentityFromStat(current)) !== JSON.stringify(expected) ||
      (suffix === '-wal' && expected.size !== '0')
    ) {
      throw new JournalLegacyRetentionError('legacy companion changed; retaining it')
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

export async function retireJournalLegacyMain(
  directory: string,
  filename: string,
  signal: AbortSignal,
  ownsProfile: () => boolean,
  matches: () => Promise<boolean>,
  lock: typeof acquireJournalLegacyFileLock,
  prepare: (
    manifest: LegacyCompanionManifest,
    destination: LegacyDestinationIdentity
  ) => Promise<void>
): Promise<boolean> {
  let lease: Awaited<ReturnType<typeof acquireJournalLegacyFileLock>> | undefined
  try {
    lease = await lock(filename, signal)
    const validate = async () => {
      const matched = await matches()
      if (!lease?.held() || signal.aborted || !ownsProfile() || !matched) {
        throw new Error('legacy retirement lost exclusive ownership')
      }
    }
    await validate()
    if (await legacyFilePresent(`${filename}-journal`)) {
      throw new JournalLegacyRetentionError('legacy rollback journal retained')
    }
    const manifest: LegacyCompanionManifest = {}
    for (const suffix of LEGACY_COMPANION_SUFFIXES) {
      if (await legacyFilePresent(filename + suffix)) {
        const file = await lstat(filename + suffix, { bigint: true })
        if (!file.isFile()) {
          throw new JournalLegacyRetentionError('legacy companion is not a regular file')
        }
        manifest[suffix] = journalLegacyFileIdentityFromStat(file)
      }
    }
    if (manifest['-wal'] && manifest['-wal'].size !== '0') {
      throw new JournalLegacyRetentionError('legacy WAL still contains data')
    }
    const domain = journalDomainDatabasePath(directory)
    const destination = await legacyDestinationIdentity(domain)
    await syncLegacyDestination(directory, filename)
    if (JSON.stringify(await legacyDestinationIdentity(domain)) !== JSON.stringify(destination)) {
      throw new Error('journal destination changed during sync')
    }
    await prepare(manifest, destination)
    await validate()
    if (JSON.stringify(await legacyDestinationIdentity(domain)) !== JSON.stringify(destination)) {
      throw new Error('journal destination changed after prepare')
    }
    if (process.platform === 'win32') {
      await lease.close()
      lease = undefined
    }
    if (!(await matches()) || !ownsProfile() || signal.aborted || (lease && !lease.held())) {
      return false
    }
    await unlink(filename)
    await syncLegacyDirectory(directory)
    return true
  } finally {
    await lease?.close()
  }
}
