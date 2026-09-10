import type { ProviderResourceDiagnosticOperation } from '../../shared/provider-resource-diagnostics'

export type PingRequest = { id: string; type: 'ping' }

export type DaemonDiagnosticRequest =
  | PingRequest
  | {
      id: string
      type: 'providerResourceDiagnostic'
      payload: ProviderResourceDiagnosticOperation
    }
