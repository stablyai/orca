import {
  createAiVaultServicePendingCall,
  type AiVaultServicePendingCall
} from './session-scanner-service-client-state'
import type { AiVaultServiceScanListener } from './session-scanner-service-request-deadline'
import type { AiVaultServiceRequest } from './session-scanner-service-protocol'

export function aiVaultServiceCallPromise<T>(
  request: AiVaultServiceRequest,
  signal: AbortSignal | undefined,
  listener: AiVaultServiceScanListener | undefined,
  cancel: (call: AiVaultServicePendingCall) => void,
  enqueue: (call: AiVaultServicePendingCall) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const call = createAiVaultServicePendingCall(
      request,
      signal,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the operation caller selects T to match its typed service result.
      resolve as (value: unknown) => void,
      reject,
      cancel,
      listener
    )
    enqueue(call)
  })
}
