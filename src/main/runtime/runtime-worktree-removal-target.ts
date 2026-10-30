import type { RuntimeStore } from './runtime-store-contract'
import {
  parseExactWorktreeIdSelector,
  type RuntimeWorktreeRemovalTarget
} from './runtime-worktree-selection'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { ExecutionHostId } from '../../shared/execution-host'

export async function resolveRuntimeWorktreeRemovalTarget(args: {
  selector: string
  store: RuntimeStore | null
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
  resolveExplicitWorktreeIdScoped: (
    worktreeId: string,
    hostId: ExecutionHostId
  ) => Promise<ResolvedWorktree | null>
  requiredHostId?: ExecutionHostId
}): Promise<RuntimeWorktreeRemovalTarget> {
  try {
    const exactTarget = parseExactWorktreeIdSelector(args.selector)
    const worktree =
      exactTarget && args.requiredHostId
        ? ((await args.resolveExplicitWorktreeIdScoped(exactTarget.id, args.requiredHostId)) ??
          (() => {
            throw new Error('selector_not_found')
          })())
        : await args.resolveWorktree(args.selector)
    const target = { id: worktree.id, repoId: worktree.repoId, path: worktree.path }
    return worktree.pushTarget ? { ...target, pushTarget: worktree.pushTarget } : target
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'selector_not_found') {
      throw error
    }
    const target = parseExactWorktreeIdSelector(args.selector)
    const meta = target ? args.store?.getWorktreeMeta(target.id) : undefined
    if (
      !target ||
      !meta ||
      (args.requiredHostId !== undefined && meta.hostId !== args.requiredHostId)
    ) {
      throw error
    }
    return meta.pushTarget ? { ...target, pushTarget: meta.pushTarget } : target
  }
}
