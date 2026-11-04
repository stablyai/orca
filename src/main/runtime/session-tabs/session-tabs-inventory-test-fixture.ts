import type { OrcaRuntimeService } from '../orca-runtime'

export function getSessionTabsInventoryPublication(runtime: OrcaRuntimeService) {
  return {
    get epoch(): number | null {
      const epoch: unknown = Object.getOwnPropertyDescriptor(
        runtime,
        'sessionTabsInventoryPublicationEpoch'
      )?.value
      if (epoch === null || typeof epoch === 'number') {
        return epoch
      }
      throw new Error('Runtime does not own a session tab inventory publication epoch')
    },
    get pendingWaiterCount(): number {
      const waiters: unknown = Object.getOwnPropertyDescriptor(
        runtime,
        'sessionTabsInventoryWaiters'
      )?.value
      if (!(waiters instanceof Set)) {
        throw new Error('Runtime does not own session tab inventory waiters')
      }
      return waiters.size
    }
  }
}
