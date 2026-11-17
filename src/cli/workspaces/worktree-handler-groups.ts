import type { HandlerGroup } from '../dispatch/handler-group-manifest'

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
    load: async () => (await import('./worktree.js')).WORKTREE_HANDLERS
  },
  {
    name: 'worktree-activate',
    keys: ['worktree activate'],
    load: async () => (await import('./worktree-activate.js')).WORKTREE_ACTIVATE_HANDLERS
  },
  {
    name: 'worktree-notes',
    keys: ['worktree notes list', 'worktree notes add', 'worktree notes clear'],
    load: async () => (await import('./worktree-notes.js')).WORKTREE_NOTES_HANDLERS
  },
  {
    name: 'workspace-cleanup',
    keys: ['workspace cleanup preview', 'workspace cleanup run', 'workspace cleanup report'],
    load: async () => (await import('./workspace-cleanup.js')).WORKSPACE_CLEANUP_HANDLERS
  }
]
