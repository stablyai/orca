import type { SessionScanInactivity } from './session-scanner-scan-inactivity'
import type { AiVaultServiceScanListener } from './session-scanner-service-request-deadline'
import type { AiVaultServiceRequest, AiVaultServiceLane } from './session-scanner-service-protocol'

export type AiVaultServicePendingCall = {
  request: AiVaultServiceRequest
  lane: AiVaultServiceLane
  signal?: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  onAbort: (() => void) | null
  cancelled: boolean
  sent: boolean
  startRetried: boolean
  stopRowsInterest?: () => void
  scanInactivity?: SessionScanInactivity
  recovering?: boolean
  scanListener?: AiVaultServiceScanListener
}
