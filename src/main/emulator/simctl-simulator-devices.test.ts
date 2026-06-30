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

import { listSimulatorDevices } from './simctl-simulator-devices'

describe('listSimulatorDevices', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    platformMock.mockReset()
    platformMock.mockReturnValue('darwin')
  })

  it('parses simctl devices on macOS', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              {
                name: 'iPhone 17 Pro',
                udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
                state: 'Shutdown',
                isAvailable: true
              }
            ]
          }
        }),
        ''
      )
    })

    await expect(listSimulatorDevices()).resolves.toEqual([
      {
        name: 'iPhone 17 Pro',
        udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
        state: 'Shutdown',
        runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
        isAvailable: true
      }
    ])
    expect(execFileMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'list', 'devices', '-j'],
      { timeout: 15_000 },
      expect.any(Function)
    )
  })

  it('returns no devices on non-macOS hosts', async () => {
    platformMock.mockReturnValue('linux')

    await expect(listSimulatorDevices()).resolves.toEqual([])
    expect(execFileMock).not.toHaveBeenCalled()
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
