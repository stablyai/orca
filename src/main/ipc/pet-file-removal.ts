import { rm } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { getPetsDir, isSafeId, resolvePetFile } from './pet-storage-paths'

/** Deletes a custom pet's stored bytes; missing files and unsafe ids are a no-op. */
export async function removePetFiles(
  id: string,
  fileName: string,
  kind: 'image' | 'bundle',
  // Why opt-in: the menu's delete is best-effort, but a CLI caller must not be told it succeeded.
  options: { throwOnError?: boolean } = {}
): Promise<void> {
  if (!isSafeId(id)) {
    return
  }
  if (kind === 'bundle') {
    // Why: defense in depth — verify path stays under pets root before recursive removal.
    const root = normalize(getPetsDir())
    const target = normalize(join(root, id))
    if (!target.startsWith(root + sep)) {
      return
    }
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      console.warn('[pet-overlay] pet:delete (bundle) failed', error)
      if (options.throwOnError) {
        throw error
      }
    }
    return
  }
  const filePath = resolvePetFile(id, fileName, 'image')
  if (!filePath) {
    return
  }
  try {
    await rm(filePath, { force: true })
  } catch (error) {
    console.warn('[pet-overlay] pet:delete failed', error)
    if (options.throwOnError) {
      throw error
    }
  }
}
