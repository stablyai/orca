import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'

async function realpathIfPresent(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** Why an import folder can't feed the store, or null when it can. */
export async function importHomeUnusableReason(
  importHome: string,
  storeHome: string
): Promise<string | null> {
  if (!isAbsolute(importHome) || parseWslUncPath(importHome)) {
    return 'not an absolute host path'
  }
  const [source, store] = await Promise.all([
    realpathIfPresent(importHome),
    realpathIfPresent(storeHome)
  ])
  if (!source) {
    return 'missing'
  }
  if (store && (isWithin(source, store) || isWithin(store, source))) {
    return 'overlaps the Codex history folder'
  }
  return null
}
