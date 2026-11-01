import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { matchEmulatorErrorCopy } from '../../shared/emulator-failure-copy'
import {
  ensureSimulatorBooted,
  listSimulatorDevices,
  resolveSimulatorUdid,
  setConfiguredSimulatorBootCommand,
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

describe('ensureSimulatorBooted', () => {
  const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
  type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

  // The device reads Booted once any boot call succeeds, like CoreSimulator after a real boot.
  function mockSimulatorHost(
    initialState: string,
    bootFailure?: { error: Error; stderr: string }
  ): void {
    let state = initialState
    execFileMock.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        if (command === 'xcrun' && args[1] === 'list') {
          const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-18-0'
          callback(
            null,
            JSON.stringify({ devices: { [runtime]: [{ name: 'iPhone 17 Pro', udid, state }] } }),
            ''
          )
          return
        }
        if (bootFailure) {
          callback(bootFailure.error, '', bootFailure.stderr)
          return
        }
        state = 'Booted'
        callback(null, '', '')
      }
    )
  }

  async function bootAndPoll(): Promise<void> {
    const booted = ensureSimulatorBooted(udid)
    await vi.advanceTimersByTimeAsync(700)
    await booted
  }

  beforeEach(() => {
    vi.useFakeTimers()
    execFileMock.mockReset()
    platformMock.mockReturnValue('darwin')
    setConfiguredSimulatorBootCommand(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('boots with simctl when the configured command is blank', async () => {
    setConfiguredSimulatorBootCommand('   ')
    mockSimulatorHost('Shutdown')

    await bootAndPoll()

    expect(execFileMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'boot', udid],
      { timeout: 45_000 },
      expect.any(Function)
    )
  })

  it.each([
    ['/usr/local/bin/simslim boot --quiet', '/usr/local/bin/simslim', ['boot', '--quiet']],
    ['bash "/Users/me/Sim Tools/boot.sh"', 'bash', ['/Users/me/Sim Tools/boot.sh']]
  ])('runs %s with the UDID appended instead of simctl', async (command, program, args) => {
    setConfiguredSimulatorBootCommand(command)
    mockSimulatorHost('Shutdown')

    await bootAndPoll()

    expect(execFileMock).toHaveBeenCalledWith(
      program,
      [...args, udid],
      { timeout: 180_000 },
      expect.any(Function)
    )
    expect(execFileMock).not.toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['boot']),
      expect.anything(),
      expect.any(Function)
    )
  })

  it('rejects with the command and its stderr when the configured command fails', async () => {
    setConfiguredSimulatorBootCommand('/usr/local/bin/simslim boot')
    mockSimulatorHost('Shutdown', {
      error: Object.assign(new Error('Command failed: /usr/local/bin/simslim boot'), { code: 1 }),
      stderr: 'Refusing to boot: another simulator is already running.\n'
    })

    const error = await ensureSimulatorBooted(udid).catch((caught: unknown) => caught)
    if (!(error instanceof Error)) {
      throw new Error('ensureSimulatorBooted should reject when the boot command fails')
    }

    expect(error).toMatchObject({
      code: 'emulator_error',
      message:
        'The simulator boot command `/usr/local/bin/simslim boot` failed. Check it in Settings > Mobile Emulator.\n\nRefusing to boot: another simulator is already running.'
    })
    // The renderer localizes thrown errors by matching this template within the error code.
    expect(matchEmulatorErrorCopy('emulator_error', error.message)).toEqual({
      code: 'simulatorBootCommandFailed',
      params: {
        command: '/usr/local/bin/simslim boot',
        detail: 'Refusing to boot: another simulator is already running.'
      }
    })
    expect(execFileMock).not.toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['boot']),
      expect.anything(),
      expect.any(Function)
    )
  })

  it('skips the configured command for an already booted simulator', async () => {
    setConfiguredSimulatorBootCommand('/usr/local/bin/simslim boot')
    mockSimulatorHost('Booted')

    await ensureSimulatorBooted(udid)

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'list', 'devices', '-j'],
      { timeout: 15_000 },
      expect.any(Function)
    )
  })
})
