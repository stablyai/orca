import { lstat, readlink, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'

/** Null when absent; undefined when it can't be told. */
export async function statUnlessAbsent(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/** The entry itself, not a link's target. Null when absent; undefined when it can't be told. */
export async function lstatUnlessAbsent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : undefined
  }
}

/** Whether a link points into a WSL distro, told from its text alone: touching it can start one. */
export async function linksIntoWsl(path: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    return false
  }
  const target = await readlink(path).catch(() => null)
  if (target === null) {
    return false
  }
  // `\\?\UNC\host\share` and `\\?\C:\` spell the same paths as `\\host\share` and `C:\`.
  const plain = target.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  return parseWslUncPath(resolve(dirname(path), plain)) !== null
}
