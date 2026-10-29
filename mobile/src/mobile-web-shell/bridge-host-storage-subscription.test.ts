import { describe, expect, it } from 'vitest'
import { notifyMirroredKey } from '../storage/mirrored-storage-keys'
import { harness } from './bridge-host-test-harness'
import { subscribePageStorage } from './bridge-host-storage-subscription'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from './page-storage-keys'

describe('page storage subscription', () => {
  it('sends eligible changes only to initialized version 2 pages and stops on teardown', () => {
    const old = harness({ ready: true })
    const current = harness({ ready: true })
    const stopOld = subscribePageStorage('host-a', '/h/host-a', 1, old.host.publishStorage)
    const stopCurrent = subscribePageStorage('host-a', '/h/host-a', 2, current.host.publishStorage)
    notifyMirroredKey('orca:markdownTextScale', '1.5')
    notifyMirroredKey('orca:pins:other-host', '[]')
    notifyMirroredKey('orca:markdownTextScale', 'x'.repeat(PAGE_STORAGE_MAX_VALUE_CHARS + 1))
    expect(old.frames().filter((frame) => frame.type === 'storage')).toEqual([])
    expect(current.frames().filter((frame) => frame.type === 'storage')).toEqual([
      { v: 1, type: 'storage', key: 'orca:markdownTextScale', value: '1.5' }
    ])
    stopOld()
    stopCurrent()
    notifyMirroredKey('orca:markdownTextScale', '2')
    expect(current.frames().filter((frame) => frame.type === 'storage')).toHaveLength(1)
  })
})
