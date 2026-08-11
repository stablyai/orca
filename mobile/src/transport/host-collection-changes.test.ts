import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  notifyHostCollectionChanged,
  resetHostCollectionChangeListenersForTests,
  subscribeHostCollectionChanges
} from './host-collection-changes'

describe('host collection changes', () => {
  beforeEach(() => resetHostCollectionChangeListenersForTests())

  it('notifies active listeners only', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeHostCollectionChanges(listener)

    notifyHostCollectionChanged({ retiredHostIds: ['retired-host'] })
    unsubscribe()
    notifyHostCollectionChanged({ retiredHostIds: [] })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ retiredHostIds: ['retired-host'] })
  })
})
