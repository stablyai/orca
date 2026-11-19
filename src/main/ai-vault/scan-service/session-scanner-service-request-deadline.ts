import {
  clearAiVaultServiceCall,
  type AiVaultServicePendingCall
} from './session-scanner-service-client-state'
import type {
  AiVaultServiceChildMessage,
  AiVaultServiceRequest
} from './session-scanner-service-protocol'
import type { AiVaultScanWork } from '../../../shared/ai-vault/scanning/ai-vault-scan-progress'

export const AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS = 15_000

export type AiVaultServiceScanListener = {
  work: (work: AiVaultScanWork) => void
}

// Large scans run until completion, cancellation, or child exit; history size must not time them out.
function armAiVaultServiceRequestDeadline(
  call: AiVaultServicePendingCall,
  onTimeout: (error: Error) => void
): void {
  if (call.request.operation === 'scan') {
    return
  }
  const timeoutMs = AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS
  if (call.timer) {
    clearTimeout(call.timer)
  }
  // Remote clients humanize this text, so a new wording would reach older ones as "stopped unexpectedly".
  call.timer = setTimeout(() => {
    onTimeout(new Error(`AI Vault service timed out after ${timeoutMs}ms.`))
  }, timeoutMs)
  call.timer.unref?.()
}

/** Startup time does not count toward request deadlines. */
export function sendAiVaultServiceCall(
  child: { send(request: AiVaultServiceRequest): unknown },
  call: AiVaultServicePendingCall,
  isActive: () => boolean,
  onTimeout: (error: Error) => void
): void {
  if (call.cancelled || !isActive()) {
    return
  }
  armAiVaultServiceRequestDeadline(call, onTimeout)
  call.sent = true
  child.send(call.request)
}

export function noteAiVaultServiceScanProgress(
  call: AiVaultServicePendingCall,
  work: AiVaultScanWork
): void {
  if (call.cancelled || !call.sent || call.request.operation !== 'scan') {
    return
  }
  call.scanListener?.work(work)
}

/** Returns whether the child's answer finished the call. */
export function answerAiVaultServiceCall(
  call: AiVaultServicePendingCall,
  message: Extract<AiVaultServiceChildMessage, { type: 'result' | 'error' | 'progress' }>
): boolean {
  if (message.type === 'progress') {
    noteAiVaultServiceScanProgress(call, message.work)
    return false
  }
  clearAiVaultServiceCall(call)
  if (!call.cancelled) {
    if (message.type === 'error') {
      call.reject(new Error(message.message))
    } else {
      call.resolve(message.value)
    }
  }
  return true
}
