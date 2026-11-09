import type { HandlerGroup } from './handler-group-manifest'

// The Orca servers this computer reaches: saved servers, the servers it manages over SSH, its SSH
// connections, and recipe VMs.
export const HOST_HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'environment',
    keys: [
      'server name',
      'host list',
      'host rm',
      'server add',
      'server list',
      'server show',
      'server rm'
    ],
    load: async () => (await import('./handlers/environment.js')).ENVIRONMENT_HANDLERS
  },
  {
    name: 'managed-server',
    keys: [
      'server status',
      'server update',
      'server rollback',
      'server recover',
      'server stop',
      'server cancel-stop',
      'server forget'
    ],
    load: async () => (await import('./handlers/managed-server.js')).MANAGED_SERVER_HANDLERS
  },
  {
    name: 'vm',
    keys: ['vm recipe doctor'],
    load: async () => (await import('./handlers/vm.js')).VM_HANDLERS
  }
]
