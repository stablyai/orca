import type { HandlerGroup } from '../dispatch/handler-group-manifest'

// Split from handler-group-manifest.ts to keep it under the max-lines limit.
export const SERVE_PAIRING_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'serve-restore',
    keys: ['serve restore resume'],
    load: async () => (await import('./serve-restore.js')).SERVE_RESTORE_HANDLERS
  },
  {
    name: 'pair',
    keys: ['pair'],
    load: async () => (await import('./pair.js')).PAIR_HANDLERS
  }
]
