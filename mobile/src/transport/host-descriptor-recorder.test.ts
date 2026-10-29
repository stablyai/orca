import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordHostDescriptorMock = vi.hoisted(() => vi.fn())
const updateHostDescriptorMock = vi.hoisted(() => vi.fn())

vi.mock('./host-descriptor-store', () => ({
  recordHostDescriptor: (...args: unknown[]) => recordHostDescriptorMock(...args)
}))

vi.mock('./host-store', () => ({
  updateHostDescriptor: (...args: unknown[]) => updateHostDescriptorMock(...args)
}))

import { recordHostDescriptorFromStatus } from './host-descriptor-recorder'
import { hostStatusSchema } from './host-status-reply-schema'

describe('recordHostDescriptorFromStatus', () => {
  beforeEach(() => {
    recordHostDescriptorMock.mockClear()
    updateHostDescriptorMock.mockReset()
    updateHostDescriptorMock.mockResolvedValue(undefined)
  })

  it('writes the normalized descriptor to both the live store and the durable one', () => {
    recordHostDescriptorFromStatus(
      'host-1',
      hostStatusSchema.parse({ machineName: ' m4airs-Air ', hostPlatform: 'darwin' })
    )
    const descriptor = { machineName: 'm4airs-Air', platform: 'darwin' }
    expect(recordHostDescriptorMock).toHaveBeenCalledWith('host-1', descriptor)
    expect(updateHostDescriptorMock).toHaveBeenCalledWith('host-1', descriptor)
  })

  it('records an answered status that carried neither field as nulls', () => {
    recordHostDescriptorFromStatus('host-1', hostStatusSchema.parse({ machineName: '  ' }))
    const descriptor = { machineName: null, platform: null }
    expect(recordHostDescriptorMock).toHaveBeenCalledWith('host-1', descriptor)
    expect(updateHostDescriptorMock).toHaveBeenCalledWith('host-1', descriptor)
  })
})
