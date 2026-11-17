// Private build only: Orca Cloud companion commands (env, secrets, local commands), loaded on demand.
import type { HandlerGroup } from '../dispatch/handler-group-manifest'

export const CLOUD_COMPANION_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'cloud-env',
    keys: [
      'cloud env show',
      'cloud env set-install-script',
      'cloud env build',
      'cloud env builds',
      'cloud env logs'
    ],
    load: async () => (await import('../handlers/cloud-env.js')).CLOUD_ENV_HANDLERS
  },
  {
    name: 'secret',
    keys: ['secret request'],
    load: async () => (await import('../handlers/secret.js')).SECRET_HANDLERS
  },
  {
    name: 'local-command',
    keys: ['local-command run', 'local-command mcp'],
    load: async () => (await import('../handlers/local-command.js')).LOCAL_COMMAND_HANDLERS
  }
]
