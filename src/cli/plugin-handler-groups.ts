import type { HandlerGroup } from './handler-group-manifest'

// Authoring runs offline; runtime commands reach the Orca host. Split so authoring never loads the RPC graph.
export const PLUGIN_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'plugin-authoring',
    keys: ['plugin create', 'plugin validate', 'plugin inspect'],
    load: async () => (await import('./handlers/plugin-authoring.js')).PLUGIN_AUTHORING_HANDLERS
  },
  {
    name: 'plugin-runtime',
    keys: [
      'plugin list',
      'plugin logs',
      'plugin enable',
      'plugin disable',
      'plugin dev load',
      'plugin dev reload',
      'plugin dev unload'
    ],
    load: async () => (await import('./handlers/plugin-runtime.js')).PLUGIN_RUNTIME_HANDLERS
  }
]
