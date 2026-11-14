import type { AiVaultRowObserver } from '../../../shared/ai-vault-scan-rows'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultScanWork } from '../../../shared/ai-vault/scanning/ai-vault-scan-progress'
import { setRowInterest } from '../scan-lifecycle/ai-vault-row-interest'
import { aiVaultScanWork, trackAiVaultScanProgress } from '../scan-lifecycle/ai-vault-scan-progress'
import { scanAiVaultSessions } from '../session-scanner'
import type {
  AiVaultServiceRequest,
  AiVaultServiceChildMessage
} from './session-scanner-service-protocol'

const rowInterests = new Set<number>()
const rowInterestListeners = new Map<number, Set<() => void>>()

function sendScanMessage(message: AiVaultServiceChildMessage): void {
  process.send?.(message)
}

export function setServiceScanRowInterest(id: number, observed: boolean): void {
  if (observed) {
    rowInterests.add(id)
  } else {
    rowInterests.delete(id)
  }
  for (const changed of rowInterestListeners.get(id) ?? []) {
    changed()
  }
}

export function clearServiceScanRowInterest(id: number): void {
  rowInterests.delete(id)
  rowInterestListeners.delete(id)
}

export async function scanReportingProgress(
  request: Extract<AiVaultServiceRequest, { operation: 'scan' }>,
  signal: AbortSignal
): Promise<{ result: AiVaultListResult; work: AiVaultScanWork | null }> {
  const stopProgress = trackAiVaultScanProgress(signal, (work) =>
    sendScanMessage({ type: 'progress', id: request.id, work })
  )
  try {
    sendScanMessage({ type: 'activity', id: request.id, started: true, allowanceMs: 0 })
    let lastActivity = 0
    let lastAllowance = -1
    const listeners = new Set<() => void>()
    rowInterestListeners.set(request.id, listeners)
    const observeRows: AiVaultRowObserver = (delta) =>
      !rowInterests.has(request.id)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            // Wait for channel drain so previews cannot accumulate behind a slow parent.
            process.send?.({ type: 'rows', id: request.id, delta }, (error: Error | null) =>
              error ? reject(error) : resolve()
            )
          })
    setRowInterest(observeRows, {
      observed: () => rowInterests.has(request.id),
      subscribe: (changed) => {
        listeners.add(changed)
        return () => {
          listeners.delete(changed)
        }
      }
    })
    const result = await scanAiVaultSessions(
      { ...request.options, signal },
      observeRows,
      (allowanceMs) => {
        const now = Date.now()
        if (allowanceMs !== lastAllowance || now - lastActivity >= 1000) {
          lastActivity = now
          lastAllowance = allowanceMs
          sendScanMessage({ type: 'activity', id: request.id, started: true, allowanceMs })
        }
      }
    )
    return { result, work: aiVaultScanWork(signal) }
  } finally {
    stopProgress()
  }
}
