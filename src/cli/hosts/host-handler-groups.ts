import type { HandlerGroup } from '../dispatch/handler-group-manifest'

// The machines Orca reaches: saved hosts and paired environments, the Orca servers it manages on
// them, and recipe VMs.
export const HOST_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'environment',
    keys: [
      'host name',
      'host list',
      'host rm',
      'environment add',
      'environment list',
      'environment show',
      'environment rm'
    ],
    load: async () => (await import('./environment.js')).ENVIRONMENT_HANDLERS
  },
  {
    name: 'managed-server',
    keys: [
      'environment status',
      'environment update',
      'environment rollback',
      'environment recover',
      'environment stop',
      'environment cancel-stop',
      'environment forget'
    ],
    load: async () => (await import('./managed-server.js')).MANAGED_SERVER_HANDLERS
  },
  {
    name: 'settings-sync',
    keys: ['settings push', 'settings pull'],
    load: async () => (await import('./settings-sync.js')).SETTINGS_SYNC_HANDLERS
  },
  {
    name: 'vm',
    keys: ['vm recipe doctor'],
    load: async () => (await import('./vm.js')).VM_HANDLERS
  },
  {
    name: 'vm-env',
    keys: ['vm env doctor'],
    load: async () => (await import('./vm-env.js')).VM_ENV_HANDLERS
  }
]
