import type { ChildProcess } from 'node:child_process'
import type { AiVaultServicePendingCall } from './session-scanner-pending-call'
import { sendAiVaultServiceCall } from './session-scanner-service-request-deadline'

export function pumpAiVaultServiceCalls(
  queue: AiVaultServicePendingCall[],
  active: Map<AiVaultServicePendingCall['lane'], AiVaultServicePendingCall>,
  ensureChild: () => Promise<ChildProcess>,
  deadline: (error: Error) => void,
  failed: (call: AiVaultServicePendingCall, error: Error) => void
): void {
  for (const lane of ['cache', 'interactive'] as const) {
    if (active.has(lane)) {
      continue
    }
    const index = queue.findIndex((call) => call.lane === lane)
    if (index === -1) {
      continue
    }
    const call = queue.splice(index, 1)[0]!
    active.set(lane, call)
    void ensureChild().then(
      (child) =>
        sendAiVaultServiceCall(child, call, () => active.get(call.lane) === call, deadline),
      (error: Error) => {
        if (active.get(lane) !== call) {
          return
        }
        active.delete(lane)
        failed(call, error)
      }
    )
  }
}
