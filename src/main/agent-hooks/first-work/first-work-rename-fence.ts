import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import type { FirstWorkAttempt } from './first-work-rename-attempts'

/** Every effect first proves the admitted workspace incarnation is still the current one. */
export function fenceFirstWorkDeps(
  deps: FirstWorkBranchRenameDeps,
  attempt: FirstWorkAttempt
): FirstWorkBranchRenameDeps {
  return {
    ...deps,
    setRenameError: (...args) => {
      attempt.assertIncarnation()
      deps.setRenameError(...args)
    },
    setDisplayName: (...args) => {
      attempt.assertIncarnation()
      deps.setDisplayName(...args)
    },
    renameWorktreeFolder: deps.renameWorktreeFolder
      ? async (...args) => {
          attempt.assertIncarnation()
          return deps.renameWorktreeFolder!(...args)
        }
      : undefined,
    onRenamed: (...args) => {
      attempt.assertIncarnation()
      deps.onRenamed(...args)
    }
  }
}
