import { stat } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'

/** A root that exists but cannot be read holds unknown skills, not none. */
export class SkillRootUnreadableError extends Error {
  constructor(cause: unknown) {
    super('Skill root could not be read', { cause })
    this.name = 'SkillRootUnreadableError'
  }
}

/** Confirmed absence returns null (nothing there); any other failed root read throws as unreadable. */
export function throwUnlessAbsent(error: unknown): null {
  if (isDefinitiveAbsence(error)) {
    return null
  }
  throw new SkillRootUnreadableError(error)
}

/** Any stat failure reads as absent unless `rejectUnreadable`, which keeps only ENOENT/ENOTDIR as absent. */
export async function skillRootExists(
  rootPath: string,
  rejectUnreadable: boolean
): Promise<boolean> {
  try {
    await stat(rootPath)
    return true
  } catch (error) {
    if (rejectUnreadable) {
      throwUnlessAbsent(error)
    }
    return false
  }
}
