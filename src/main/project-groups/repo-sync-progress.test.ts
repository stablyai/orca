import { describe, expect, it, vi } from 'vitest'
import { createRepoSyncProgressParser } from './repo-sync-progress'

describe('createRepoSyncProgressParser', () => {
  it('parses TTY checkout progress across chunks', () => {
    const onProgress = vi.fn()
    const parse = createRepoSyncProgressParser(onProgress)
    parse('\u001b[2K\rCheckout: 37% [2 jobs] (20/54) 0:12 | dev/bsp_dev/android')
    parse('_ndk @ external/android_ndk\u001b[K')
    expect(onProgress).toHaveBeenLastCalledWith({
      processedProjects: 20,
      totalProjects: 54,
      currentProject: 'external/android_ndk'
    })
  })
})
