import type { PtyFencedTerminationRequest } from '../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import type { PtySpawnResult } from '../providers/pty-provider-contract'
const historyPreservingRequests = new WeakSet<object>()

/** In-process finalization policy; the existing fenced kill wire remains unchanged. */
export function preserveFencedTerminalHistory<T extends PtyFencedTerminationRequest>(
  request: T
): T {
  historyPreservingRequests.add(request)
  return request
}

export function fencedTerminationHistoryPolicy(request: PtyFencedTerminationRequest): {
  keepHistory: boolean
} {
  return { keepHistory: historyPreservingRequests.has(request) }
}

const selectedResults = new WeakSet<object>()
export function retainSelectedTerminalHistory(result: PtySpawnResult): void {
  selectedResults.add(result)
}
export function hasSelectedTerminalHistory(result: PtySpawnResult): boolean {
  return selectedResults.has(result)
}
