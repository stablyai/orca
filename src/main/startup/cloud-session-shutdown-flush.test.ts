import { describe, expect, it, vi } from 'vitest'

const flush = vi.hoisted(() => vi.fn())

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { powerMonitor: new EventEmitter() }
})
vi.mock('../orca-profiles/profile-cloud-session-owner', () => ({
  flushUnsavedCloudSessions: flush
}))

import { powerMonitor } from 'electron'
import { installCloudSessionShutdownFlush } from './cloud-session-shutdown-flush'

describe('cloud session shutdown flush', () => {
  it('writes unsaved rotations when the OS shuts down', () => {
    installCloudSessionShutdownFlush()
    powerMonitor.emit('shutdown')
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
