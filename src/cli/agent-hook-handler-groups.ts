import type { HandlerGroup } from './handler-group-manifest'

export const AGENT_HOOK_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'agent-hooks',
    keys: ['agent hooks prepare-codex', 'agent hooks status', 'agent hooks off', 'agent hooks on'],
    load: async () => (await import('./handlers/agent-hooks.js')).AGENT_HOOK_HANDLERS
  },
  {
    name: 'agent-saved-restore',
    // The pane's agent functions run this before an agent starts; it loads only the client.
    keys: ['agent saved-restore-check'],
    load: async () =>
      (await import('./handlers/agent-saved-restore.js')).AGENT_SAVED_RESTORE_HANDLERS
  }
]
