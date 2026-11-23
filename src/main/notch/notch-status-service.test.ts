import { expect, it } from 'vitest'
import { NotchStatusService } from './notch-status-service'
import type { NotchStatusObservation } from '../../shared/notch/notch-status-summary'

it('does not turn an acknowledged remote completion unread when its inventory reconnects', () => {
  const row: NotchStatusObservation = {
    paneKey: 'runtime:peer|tab:leaf',
    executionHostId: 'runtime:peer',
    state: 'done',
    prompt: '',
    connectionId: null,
    receivedAt: 1000,
    stateStartedAt: 1000
  }
  let snapshot: NotchStatusObservation[] = [row]
  let changed = (): void => {}
  const service = new NotchStatusService({
    source: {
      getStatusSnapshot: () => snapshot,
      subscribeStatusRowMutations: (listener) => {
        changed = listener
        return () => {}
      }
    },
    scheduleFlush: (flush) => {
      flush()
      return () => {}
    }
  })
  service.start()
  expect(service.getSummary().counts.done).toBe(1)
  service.acknowledgePanes([row.paneKey], 1001)
  snapshot = []
  changed()
  snapshot = [row]
  changed()
  expect(service.getSummary().counts.done).toBe(0)
  service.stop()
  service.start()
  expect(service.getSummary().counts.done).toBe(0)
  service.stop()
})
