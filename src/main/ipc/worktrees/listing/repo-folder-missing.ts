import { stat } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'

/** A repository whose folder is gone, which an unmounted volume looks like until it returns. */
export class RepoFolderMissingError extends Error {
  constructor(repoPath: string) {
    super(`Repository folder is missing: ${repoPath}. Its volume may not be mounted.`)
    this.name = 'RepoFolderMissingError'
  }
}

export function isRepoFolderAbsent(repoPath: string): Promise<boolean> {
  return stat(repoPath).then(() => false, isDefinitiveAbsence)
}
