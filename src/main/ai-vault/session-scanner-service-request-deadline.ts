import type { AiVaultServicePendingCall } from './session-scanner-service-client-state'
import type { AiVaultServiceRequest } from './session-scanner-service-protocol'
import type { AiVaultScanWork } from '../../shared/ai-vault-scan-progress'

export const AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS = 15_000

/** Follows one scan request's reports of its work. */
export type AiVaultServiceScanListener = {
  work: (work: AiVaultScanWork) => void
}

// Why: a scan has no deadline; however long a large history takes, it ends by
// finishing, by Refresh preempting it, by every waiter leaving, or by the child exiting.
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

/** Starts an interactive call's deadline only once the child is ready to receive it. */
export function sendAiVaultServiceCall(
  // Only the send this needs, so the module stays off the direct child_process import list.
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

/** Passes a running scan's reported work to its listener; a cancelled or unsent call has none. */
export function noteAiVaultServiceScanProgress(
  call: AiVaultServicePendingCall,
  work: AiVaultScanWork
): void {
  if (call.cancelled || !call.sent || call.request.operation !== 'scan') {
    return
  }
  call.scanListener?.work(work)
}
