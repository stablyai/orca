import { describe, expect, it } from 'vitest'
import {
  MAX_PHYSICAL_FILESYSTEM_HOST_CHILDREN,
  FilesystemHostCapacity,
  processWideFilesystemHostCapacity
} from './filesystem-host-capacity'

describe('FilesystemHostCapacity', () => {
  it('reserves the final physical slot for foreground work', () => {
    const capacity = new FilesystemHostCapacity(3)
    const releaseA = capacity.reserve('background')
    const releaseB = capacity.reserve('background')

    expect(releaseA).not.toBeNull()
    expect(releaseB).not.toBeNull()
    expect(capacity.reserve('background')).toBeNull()
    const releaseForeground = capacity.reserve('foreground')
    expect(releaseForeground).not.toBeNull()
    expect(capacity.reserve('foreground')).toBeNull()

    releaseForeground?.()
    releaseForeground?.()
    expect(capacity.reservedCount).toBe(2)
  })

  it('exposes one process-wide physical budget for production supervisors', () => {
    expect(processWideFilesystemHostCapacity.maximum).toBe(MAX_PHYSICAL_FILESYSTEM_HOST_CHILDREN)
  })
})
