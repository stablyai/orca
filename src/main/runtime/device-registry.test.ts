import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writeSecureJsonFileMock, hardenExistingSecureFileMock } = vi.hoisted(() => ({
  writeSecureJsonFileMock: vi.fn(),
  hardenExistingSecureFileMock: vi.fn()
}))

vi.mock('../../shared/secure-file', () => ({
  writeSecureJsonFile: writeSecureJsonFileMock,
  hardenExistingSecureFile: hardenExistingSecureFileMock
}))

import { DeviceRegistry } from './device-registry'

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('DeviceRegistry', () => {
  beforeEach(() => {
    writeSecureJsonFileMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
  })

  it('keeps the last-seen persist off the caller stack (mobile pairing handshake)', async () => {
    // Why: updateLastSeen runs inside the E2EE auth path, before the server sends
    // e2ee_authenticated. writeSecureJsonFile costs seconds on Windows because
    // writeSecureFile spawns PowerShell twice, synchronously, to apply ACLs — past
    // the mobile client's handshake budget, which made pairing impossible there.
    const registry = new DeviceRegistry('/does-not-exist')
    const device = registry.addDevice('Phone')
    writeSecureJsonFileMock.mockClear()

    registry.updateLastSeen(device.deviceId)
    expect(writeSecureJsonFileMock).not.toHaveBeenCalled()

    await nextMacrotask()
    expect(writeSecureJsonFileMock).toHaveBeenCalledTimes(1)
  })

  it('records the last-seen timestamp once the deferred write lands', async () => {
    const registry = new DeviceRegistry('/does-not-exist')
    const device = registry.addDevice('Phone')
    expect(device.lastSeenAt).toBe(0)

    registry.updateLastSeen(device.deviceId)
    await nextMacrotask()

    const stored = registry.listDevices().find((d) => d.deviceId === device.deviceId)
    expect(stored?.lastSeenAt).toBeGreaterThan(0)
  })

  it('ignores an unknown device without scheduling a write', async () => {
    const registry = new DeviceRegistry('/does-not-exist')
    registry.addDevice('Phone')
    writeSecureJsonFileMock.mockClear()

    registry.updateLastSeen('not-a-real-device-id')
    await nextMacrotask()

    expect(writeSecureJsonFileMock).not.toHaveBeenCalled()
  })
})
