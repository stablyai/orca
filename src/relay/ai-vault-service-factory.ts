import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { RelayAiVaultUsageServiceClient } from './ai-vault-service-usage-client'
import { spawnRelayAiVaultService } from './ai-vault-service-spawn'

export function createRelayAiVaultService(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform
): RelayAiVaultUsageServiceClient {
  return new RelayAiVaultUsageServiceClient({
    init: { remoteHome, hostPlatform },
    processFactory: spawnRelayAiVaultService
  })
}
