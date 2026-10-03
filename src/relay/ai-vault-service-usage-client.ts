import type {
  SshClaudeUsageScanParams,
  SshClaudeUsageScanResult
} from '../main/claude-usage/ssh-usage-relay-contract'
import { RelayAiVaultServiceClient } from './ai-vault-service-client'
import type { RelayUsageScanServiceApi } from './ai-vault-service-client-state'

/** Usage scans share the AI Vault sidecar so a cold scan never runs on the relay event loop. */
export class RelayAiVaultUsageServiceClient
  extends RelayAiVaultServiceClient
  implements RelayUsageScanServiceApi
{
  scanClaudeUsage(
    params: SshClaudeUsageScanParams,
    signal?: AbortSignal
  ): Promise<SshClaudeUsageScanResult> {
    return this.request(
      { type: 'request', id: this.nextId++, operation: 'claudeUsage', params },
      signal
    )
  }
}
