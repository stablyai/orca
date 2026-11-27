import { rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'

export class RuntimeReleaseRestoreError extends AggregateError {}

export async function publishRuntimeRelease(
  release: string,
  folder: string,
  label: string
): Promise<void> {
  const damaged = join(dirname(release), 'damaged')
  let replacing = false
  try {
    await rename(folder, damaged)
    replacing = true
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  try {
    await rename(release, folder)
  } catch (error) {
    if (replacing) {
      try {
        await rename(damaged, folder)
      } catch (restoreError) {
        throw new RuntimeReleaseRestoreError(
          [error, restoreError],
          `Could not replace ${label}; the previous copy is kept at ${damaged}`
        )
      }
    }
    throw error
  }
}
