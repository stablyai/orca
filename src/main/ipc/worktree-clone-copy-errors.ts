/** A copy-on-write backend (APFS `clonefile` on macOS, `FICLONE` reflink on
 *  Linux) cannot serve this source/target pair: different volumes, a
 *  filesystem without the feature, or the feature switched off. Nothing was
 *  written, so callers fall back per mode without logging. */
export class WorktreeCloneUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeCloneUnavailableError'
  }
}

export class WorktreeLinkedPathTargetExistsError extends Error {
  constructor(target: string) {
    super(`Worktree linked path target already exists: ${target}`)
    this.name = 'WorktreeLinkedPathTargetExistsError'
  }
}

export function isAlreadyExistsError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'EEXIST'
}
