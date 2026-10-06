// One execution-host service owns profile persistence across IPC and runtime consumers.
import { homedir } from 'node:os'
import { AgentProfileConnectionService } from './connection-service'
import type { ProfileConnectionDependencies } from './connection-contracts'
import {
  createManagedProfileAdapters,
  type ManagedProfileServices
} from './managed-provider-bindings'

export function createAgentProfileConnectionService(
  services: ManagedProfileServices &
    Partial<Pick<ProfileConnectionDependencies, 'host' | 'detectExecutable'>>
): AgentProfileConnectionService {
  return new AgentProfileConnectionService({
    host: services.host ?? {
      hostId: 'local',
      platform: process.platform,
      isWsl: Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
      home: homedir(),
      shell: process.env.SHELL ?? '/bin/sh',
      pathEnv: process.env.PATH
    },
    detectExecutable: services.detectExecutable,
    adapters: createManagedProfileAdapters(services),
    store: {
      read: () => services.store.getSettings().agentLaunchProfiles ?? [],
      write: async (profiles) => {
        services.store.updateSettings({ agentLaunchProfiles: profiles }, { notifyListeners: true })
      }
    }
  })
}
