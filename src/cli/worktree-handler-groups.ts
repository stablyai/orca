import type { HandlerGroup } from './handler-group-manifest'

export const WORKTREE_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'worktree',
    keys: [
      'worktree ps',
      'worktree list',
      'worktree show',
      'worktree current',
      'worktree create',
      'worktree set',
      'worktree rm'
    ],
    load: async () => {
      const { WORKTREE_HANDLERS } = await import('./handlers/worktree.js')
      // Private build: `worktree create --on cloud` goes to the Orca Cloud API, not the runtime.
      const { maybeCreateWorktreeOnCloud } = await import('./cloud/worktree-create-on-cloud.js')
      const create = WORKTREE_HANDLERS['worktree create']!
      return {
        ...WORKTREE_HANDLERS,
        'worktree create': async (context) => {
          if (await maybeCreateWorktreeOnCloud(context)) {
            return
          }
          return create(context)
        }
      }
    }
  },
  {
    name: 'worktree-activate',
    keys: ['worktree activate'],
    load: async () => (await import('./handlers/worktree-activate.js')).WORKTREE_ACTIVATE_HANDLERS
  }
]
