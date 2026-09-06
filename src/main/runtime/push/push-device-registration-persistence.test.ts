import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../mobile-pairing-files'
import type { MobilePushRegistration } from '../../../shared/mobile-push-contract'

const REGISTRATION: MobilePushRegistration = {
  registrationId: 'reg-1',
  platform: 'ios',
  filter: { sources: ['agent-task-complete'], agentStates: ['needs-input', 'finished'] },
  registeredAt: 1_770_000_000_000
}

function userDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-push-registry-'))
}

function rewriteRegistry(dir: string, mutate: (devices: Record<string, unknown>[]) => void): void {
  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const devices: Record<string, unknown>[] = JSON.parse(readFileSync(path, 'utf-8'))
  mutate(devices)
  writeFileSync(path, JSON.stringify(devices))
}

describe('DeviceRegistry push registrations', () => {
  it('persists a registration across a restart', () => {
    const dir = userDataDir()
    const device = new DeviceRegistry(dir).addDevice('phone', 'mobile')
    expect(new DeviceRegistry(dir).setPushRegistration(device.deviceId, REGISTRATION)).toBe(true)

    expect(new DeviceRegistry(dir).getDevice(device.deviceId)?.pushRegistration).toEqual(
      REGISTRATION
    )
  })

  it('clears a registration when the gateway reports the token dead', () => {
    const dir = userDataDir()
    const registry = new DeviceRegistry(dir)
    const device = registry.addDevice('phone', 'mobile')
    registry.setPushRegistration(device.deviceId, REGISTRATION)

    expect(registry.setPushRegistration(device.deviceId, null)).toBe(true)
    expect(new DeviceRegistry(dir).getDevice(device.deviceId)?.pushRegistration).toBeUndefined()
  })

  it('refuses to register a runtime-scoped device', () => {
    const dir = userDataDir()
    const registry = new DeviceRegistry(dir)
    const cli = registry.addDevice('cli', 'runtime')

    expect(registry.setPushRegistration(cli.deviceId, REGISTRATION)).toBe(false)
  })

  it('loads a registry written before push existed', () => {
    const dir = userDataDir()
    const device = new DeviceRegistry(dir).addDevice('phone', 'mobile')
    rewriteRegistry(dir, (devices) => {
      for (const entry of devices) {
        delete entry.pushRegistration
      }
    })

    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.listDevices()).toHaveLength(1)
    expect(reloaded.getDevice(device.deviceId)?.pushRegistration).toBeUndefined()
  })

  it.each([
    ['a malformed registration', { registrationId: 'reg-1' }],
    ['an unknown platform', { ...REGISTRATION, platform: 'windows-phone' }],
    ['a missing filter', { ...REGISTRATION, filter: undefined }],
    ['a non-object', 'nonsense']
  ])('keeps the device but drops %s', (_name, pushRegistration) => {
    const dir = userDataDir()
    const device = new DeviceRegistry(dir).addDevice('phone', 'mobile')
    rewriteRegistry(dir, (devices) => {
      for (const entry of devices) {
        entry.pushRegistration = pushRegistration
      }
    })

    const reloaded = new DeviceRegistry(dir)
    expect(reloaded.listDevices()).toHaveLength(1)
    expect(reloaded.getDevice(device.deviceId)?.pushRegistration).toBeUndefined()
  })

  it('drops only the unknown members of a stored filter', () => {
    const dir = userDataDir()
    const device = new DeviceRegistry(dir).addDevice('phone', 'mobile')
    rewriteRegistry(dir, (devices) => {
      for (const entry of devices) {
        entry.pushRegistration = {
          ...REGISTRATION,
          filter: { sources: ['agent-task-complete', 'smoke-signal'], agentStates: ['finished'] }
        }
      }
    })

    expect(new DeviceRegistry(dir).getDevice(device.deviceId)?.pushRegistration?.filter).toEqual({
      sources: ['agent-task-complete'],
      agentStates: ['finished']
    })
  })
})
