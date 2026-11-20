import { lstat, stat } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

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
