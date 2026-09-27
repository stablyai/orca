import {
  SSH_USAGE_SCAN_CLAUDE_METHOD,
  normalizeSshClaudeUsageScanParams
} from '../main/claude-usage/ssh-usage-relay-contract'
import type { RelayDispatcher } from './dispatcher'
import type { RelayUsageScanServiceApi } from './ai-vault-service-client-state'
import { relayLogLine } from './relay-diagnostic-log'

export class UsageScanHandler {
  constructor(dispatcher: RelayDispatcher, service: RelayUsageScanServiceApi | undefined) {
    // Why: leaving the method unregistered makes the desktop treat this host as
    // unsupported and skip it, instead of surfacing a scan error in Settings.
    if (!service) {
      relayLogLine('[relay] Usage analytics disabled: service unavailable')
      return
    }
    // Why the AI Vault sidecar: a cold scan parses every transcript, which must
    // not stall the relay event loop that carries PTY traffic.
    dispatcher.onRequest(SSH_USAGE_SCAN_CLAUDE_METHOD, (params, context) =>
      service.scanClaudeUsage(normalizeSshClaudeUsageScanParams(params), context.signal)
    )
  }
}
