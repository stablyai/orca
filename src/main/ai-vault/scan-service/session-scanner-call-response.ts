import {
  clearAiVaultServiceCall,
  type AiVaultServicePendingCall
} from './session-scanner-service-client-state'
import { AiVaultScanStalledError } from './session-scanner-scan-inactivity'
import type { AiVaultServiceChildMessage } from './session-scanner-service-protocol'

export function settleAiVaultServiceResponse(
  call: AiVaultServicePendingCall,
  message: AiVaultServiceChildMessage
): void {
  clearAiVaultServiceCall(call)
  if (call.recovering && !call.cancelled) {
    rejectStalledAiVaultCall(call)
    return
  }
  if (!call.cancelled) {
    if (message.type === 'error') {
      call.reject(new Error(message.message))
    } else if (message.type === 'result') {
      call.resolve(message.value)
    }
  }
}

export function rejectStalledAiVaultCall(call: AiVaultServicePendingCall): void {
  clearAiVaultServiceCall(call)
  call.reject(new AiVaultScanStalledError())
}
