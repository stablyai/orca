import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

const { execFileMock, platformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  platformMock: vi.fn(() => 'darwin')
}))

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    platform: platformMock
  }
})

vi.mock('./serve-sim-execution', () => ({
  execServeSimCommand: vi.fn()
}))

import {
  listSimulatorDevices,
  resolveSimulatorUdid,
  shutdownSimulatorDevice
} from './simctl-simulator-devices'

describe('listSimulatorDevices', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    platformMock.mockReset()
    platformMock.mockReturnValue('darwin')
  })

  it('normalizes missing simctl errors for UI and CLI callers', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Command failed: xcrun simctl list devices -j'), { code: 72 }),
        '',
        'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH'
      )
    })

    const error = await listSimulatorDevices().catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: 'emulator_simctl_unavailable',
      message: expect.stringContaining('Xcode Simulator tools are unavailable')
    })
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('Command failed')
  })
})

describe('resolveSimulatorUdid', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    platformMock.mockReturnValue('darwin')
  })

  it('prefers an exact name over an earlier device whose name only contains it', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
              {
                name: 'iPhone 17e',
                udid: '645A2204-ED7C-4253-B298-2749820B1B7E',
                state: 'Shutdown'
              },
              { name: 'iPhone 17', udid: '1BD4732B-EC1A-4074-8C70-6AC369607185', state: 'Shutdown' }
            ]
          }
        }),
        ''
      )
    })
    const serveSim = { command: 'serve-sim', baseArgs: [], usesElectronAsNode: false }

    await expect(resolveSimulatorUdid('iPhone 17', serveSim)).resolves.toBe(
      '1BD4732B-EC1A-4074-8C70-6AC369607185'
    )
    await expect(resolveSimulatorUdid('iPHONE 17', serveSim)).resolves.toBe(
      '1BD4732B-EC1A-4074-8C70-6AC369607185'
    )
    await expect(resolveSimulatorUdid('17e', serveSim)).resolves.toBe(
      '645A2204-ED7C-4253-B298-2749820B1B7E'
    )
  })
})

describe('shutdownSimulatorDevice', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    platformMock.mockReset()
    platformMock.mockReturnValue('darwin')
  })

  it('treats an already-shut-down device as success', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        Object.assign(
          new Error('Command failed: xcrun simctl shutdown AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'),
          { code: 164 }
        ),
        '',
        'Unable to shutdown device in current state: Shutdown'
      )
    })

    await expect(
      shutdownSimulatorDevice('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
    ).resolves.toBeUndefined()
  })

  it('propagates real shutdown failures instead of swallowing them', async () => {
    // Command text always contains shutdown; only the actual device state proves it is already off.
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        Object.assign(
          new Error('Command failed: xcrun simctl shutdown AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'),
          { killed: true, signal: 'SIGTERM' }
        ),
        '',
        ''
      )
    })

    await expect(
      shutdownSimulatorDevice('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
    ).rejects.toMatchObject({ code: 'emulator_error' })
  })

  it('rejects current-state failures that are not already shut down', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        Object.assign(
          new Error('Command failed: xcrun simctl shutdown AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'),
          { code: 164 }
        ),
        '',
        'Unable to shutdown device in current state: Booting'
      )
    })

    await expect(
      shutdownSimulatorDevice('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
    ).rejects.toMatchObject({ code: 'emulator_error' })
  })
})
