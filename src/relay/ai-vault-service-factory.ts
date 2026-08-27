import { resolveDevinTranscriptsDir } from '../main/ai-vault/session-scanner-devin-paths'
import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { RelayAiVaultServiceClient } from './ai-vault-service-client'
import { spawnRelayAiVaultService } from './ai-vault-service-spawn'

export function createRelayAiVaultService(
  remoteHome: string,
  hostPlatform: RemoteHostPlatform,
  baseEnv: NodeJS.ProcessEnv = process.env
): RelayAiVaultServiceClient {
  return new RelayAiVaultServiceClient({
    init: {
      remoteHome,
      hostPlatform,
      devinTranscriptsDir: resolveDevinTranscriptsDir({
        env: baseEnv,
        homeDir: remoteHome,
        platform: hostPlatform.os
      })
    },
    processFactory: spawnRelayAiVaultService
  })
}
