import type { ChildProcess } from 'node:child_process'
import type { AiVaultServicePendingCall } from './session-scanner-pending-call'
import type { AiVaultServiceChildMessage } from './session-scanner-service-protocol'
import { SessionScanInactivity } from './session-scanner-scan-inactivity'

export function handleAiVaultServiceScanMessage(
  call: AiVaultServicePendingCall,
  message: AiVaultServiceChildMessage,
  stalled: () => void
): boolean {
  if (message.type === 'activity') {
    if (!call.cancelled && !call.recovering && call.request.operation === 'scan') {
      call.scanInactivity ??= new SessionScanInactivity(call.signal, stalled)
      call.scanInactivity.activity(message.allowanceMs)
    }
    return true
  }
  if (message.type === 'rows') {
    if (!call.cancelled && !call.recovering) {
      void call.scanListener?.rows?.(message.delta)
    }
    return true
  }
  return false
}

export function recoverAiVaultScanCall(
  call: AiVaultServicePendingCall,
  child: ChildProcess | null,
  fault: (error: Error) => void
): void {
  if (call.cancelled || call.recovering) {
    return
  }
  call.scanInactivity?.dispose()
  call.scanInactivity = undefined
  call.recovering = true
  child?.send({ type: 'cancel', id: call.request.id })
  call.timer = setTimeout(
    () => fault(new Error('AI Vault service did not cancel within 2000ms.')),
    2000
  )
  call.timer.unref?.()
}
