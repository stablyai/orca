import type { HandlerGroup } from './handler-group-manifest'

// Authoring runs offline; runtime commands reach the Orca host. Split so authoring never loads the RPC graph.
export const PLUGIN_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'plugin-authoring',
    keys: [
      'plugin create',
      'plugin types',
      'plugin validate',
      'plugin inspect',
      'plugin release-entry',
      'plugin test',
      'plugin check'
    ],
    load: async () => (await import('./handlers/plugin-authoring.js')).PLUGIN_AUTHORING_HANDLERS
  },
  {
    name: 'plugin-runtime',
    keys: [
      'plugin list',
      'plugin logs',
      'plugin enable',
      'plugin disable',
      'plugin system on',
      'plugin system off',
      'plugin restart',
      'plugin dev load',
      'plugin dev reload',
      'plugin dev inspect',
      'plugin dev unload'
    ],
    load: async () => (await import('./handlers/plugin-runtime.js')).PLUGIN_RUNTIME_HANDLERS
  },
  {
    name: 'plugin-dev-watch',
    keys: ['plugin dev watch'],
    load: async () => (await import('./handlers/plugin-dev-watch.js')).PLUGIN_DEV_WATCH_HANDLERS
  },
  {
    name: 'plugin-dev-emit',
    keys: ['plugin dev emit'],
    load: async () => (await import('./handlers/plugin-dev-emit.js')).PLUGIN_DEV_EMIT_HANDLERS
  },
  {
    name: 'plugin-dev-request',
    keys: ['plugin dev request'],
    load: async () => (await import('./handlers/plugin-dev-request.js')).PLUGIN_DEV_REQUEST_HANDLERS
  },
  {
    name: 'plugin-view',
    keys: ['plugin open', 'plugin shot'],
    load: async () => (await import('./handlers/plugin-view.js')).PLUGIN_VIEW_HANDLERS
  }
]
