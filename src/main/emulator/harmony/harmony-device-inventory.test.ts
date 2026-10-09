import { describe, expect, it, vi } from 'vitest'
import { correlateInstances, listHdcTargets, mergeHarmonyDevices } from './harmony-device-inventory'
import type { HarmonyEmulatorInstance } from './harmony-emulator-instances'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

function instance(overrides: Partial<HarmonyEmulatorInstance>): HarmonyEmulatorInstance {
  return {
    name: 'Instance',
    instancePath: '/deployed/Instance',
    imageRoot: '',
    isRunning: false,
    ...overrides
  }
}

describe('correlateInstances', () => {
  it('matches an explicit hdc port', () => {
    const instances = [instance({ name: 'A', hdcPort: 5555, isRunning: true })]
    const pairs = correlateInstances(instances, ['127.0.0.1:5555'])
    expect(pairs.get('A')).toBe('127.0.0.1:5555')
  })

  it('pairs one running instance with the single local target', () => {
    const instances = [instance({ name: 'A', isRunning: true })]
    const pairs = correlateInstances(instances, ['127.0.0.1:5555'])
    expect(pairs.get('A')).toBe('127.0.0.1:5555')
  })

  it('pairs one running instance with the single free target', () => {
    const pairs = correlateInstances([instance({ name: 'A', isRunning: true })], ['127.0.0.1:5555'])
    expect(pairs.get('A')).toBe('127.0.0.1:5555')
  })

  it('does not pair multiple port-less instances by array order', () => {
    const instances = [
      instance({ name: 'A', isRunning: true }),
      instance({ name: 'B', isRunning: true })
    ]
    expect(correlateInstances(instances, ['127.0.0.1:5555', '127.0.0.1:10000']).size).toBe(0)
  })

  it('leaves ambiguous counts uncorrelated', () => {
    const instances = [instance({ name: 'A', isRunning: true })]
    // One running instance but two free targets: ambiguous, no pair.
    const pairs = correlateInstances(instances, ['127.0.0.1:5555', '127.0.0.1:10000'])
    expect(pairs.size).toBe(0)
  })

  it('does not pair stopped instances', () => {
    const instances = [instance({ name: 'A', isRunning: false })]
    expect(correlateInstances(instances, ['127.0.0.1:5555']).size).toBe(0)
  })
})

describe('mergeHarmonyDevices', () => {
  it('emits booted correlated instances and shutdown others', () => {
    const instances = [
      instance({ name: 'A', isRunning: true }),
      instance({ name: 'B', isRunning: false })
    ]
    const correlation = new Map([['A', '127.0.0.1:5555']])
    expect(mergeHarmonyDevices(instances, ['127.0.0.1:5555'], correlation)).toEqual([
      {
        backend: 'harmonyos',
        id: '127.0.0.1:5555',
        name: 'A',
        state: 'booted',
        detail: 'emulator',
        isAvailable: true
      },
      {
        backend: 'harmonyos',
        id: 'B',
        name: 'B',
        state: 'shutdown',
        detail: 'instance',
        isAvailable: true
      }
    ])
  })

  it('adds unpaired physical targets as devices', () => {
    const devices = mergeHarmonyDevices(
      [instance({ name: 'A' })],
      ['127.0.0.1:5555', 'USBSERIAL123'],
      new Map()
    )
    expect(devices.slice(1)).toEqual([
      {
        backend: 'harmonyos',
        id: '127.0.0.1:5555',
        name: '127.0.0.1:5555',
        state: 'booted',
        detail: 'emulator',
        isAvailable: true
      },
      {
        backend: 'harmonyos',
        id: 'USBSERIAL123',
        name: 'USBSERIAL123',
        state: 'booted',
        detail: 'device',
        isAvailable: true
      }
    ])
  })
})

describe('listHdcTargets', () => {
  const SDK: HarmonySdkPaths = {
    sdkRoot: '/sdk',
    hdc: '/sdk/hdc',
    emulator: '/sdk/Emulator'
  }

  it('parses targets on success and returns [] on failure', async () => {
    const okRunner: HarmonyCommandRunner = async () => ({
      stdout: '127.0.0.1:5555',
      stderr: '',
      code: 0
    })
    expect(await listHdcTargets(okRunner, SDK)).toEqual(['127.0.0.1:5555'])

    const failRunner = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: '',
      stderr: 'x',
      code: 1
    }))
    expect(await listHdcTargets(failRunner, SDK)).toEqual([])
  })
})
