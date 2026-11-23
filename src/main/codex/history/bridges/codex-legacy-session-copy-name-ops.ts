import type { BigIntStats } from 'node:fs'
import { link, lstat, unlink } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

/** Links a name without replacing whatever has taken it. */
export async function linkUnlessTaken(existingPath: string, path: string): Promise<void> {
  try {
    await link(existingPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
      throw error
    }
  }
}

export function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ino !== 0n
}

export async function lstatIfPresent(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
}
