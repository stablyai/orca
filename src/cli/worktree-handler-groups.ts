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
    load: async () => (await import('./handlers/worktree.js')).WORKTREE_HANDLERS
  },
  {
    name: 'worktree-activate',
    keys: ['worktree activate'],
    load: async () => (await import('./handlers/worktree-activate.js')).WORKTREE_ACTIVATE_HANDLERS
  }
]
