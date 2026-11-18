import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { removeDirectoryLink } from '../../../filesystem/merged-directory-link'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

async function snapshot(source: string, destination: string, overwrite = false): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: overwrite,
    filter: async (from, to) => {
      if ((await lstat(from)).isSymbolicLink()) {
        throw new Error(
          'Shared Claude history contains a user-owned link. Resolve it before isolating this account.'
        )
      }
      const existing = await lstat(to).catch((error) => {
        if (isDefinitiveAbsence(error)) {
          return null
        }
        throw error
      })
      if (existing?.isSymbolicLink()) {
        throw new Error('Private Claude history contains a user-owned link.')
      }
      return true
    }
  })
}

export async function restoreClaudeHistorySnapshot(home: string, name: string): Promise<void> {
  const pending = join(home, `${name}.orca-private-history-pending`)
  const entry = await lstat(pending).catch((error) => {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  })
  if (!entry) {
    return
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('The pending Claude history snapshot is not a private directory.')
  }
  const target = join(home, name)
  const current = await lstat(target).catch((error) => {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  })
  if (current?.isSymbolicLink()) {
    return
  }
  if (!current) {
    await rename(pending, target)
  } else {
    await snapshot(pending, target)
    await rm(pending, { recursive: true })
  }
}

export async function detachClaudeHistoryDirectory(
  home: string,
  shared: string,
  name: string
): Promise<void> {
  const target = join(home, name)
  const pending = join(home, `${name}.orca-private-history-pending`)
  await mkdir(pending, { recursive: true, mode: 0o700 })
  const source = await lstat(shared).catch((error) => {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  })
  if (source) {
    await snapshot(shared, pending, true)
  }
  await removeDirectoryLink(target)
  await restoreClaudeHistorySnapshot(home, name)
}
