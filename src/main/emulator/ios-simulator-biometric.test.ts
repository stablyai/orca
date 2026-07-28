import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

const { execFileMock, platformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  platformMock: vi.fn(() => 'darwin')
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, platform: platformMock }
})

const { sendIosSimulatorBiometricEvent } = await import('./ios-simulator-biometric')

const UDID = '0A2C4CFA-CC0E-4C88-9E58-2E3FDA18B455'

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

// Mirrors notifyutil: -g echoes "<key> <value>" for whatever was last set.
function respondLikeNotifyutil(): void {
  const state = new Map<string, string>()
  execFileMock.mockImplementation(
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      const [flag, key, value] = args.slice(4)
      if (flag === '-s') {
        state.set(key, value)
      }
      const stdout = flag === '-g' ? `${key} ${state.get(key) ?? '0'}\n` : ''
      queueMicrotask(() => callback(null, stdout, ''))
    }
  )
}

function notifyutilArgs(): string[][] {
  return execFileMock.mock.calls.map((call) => call[1] as string[])
}

beforeEach(() => {
  execFileMock.mockReset()
  platformMock.mockReturnValue('darwin')
  respondLikeNotifyutil()
})

describe('sendIosSimulatorBiometricEvent', () => {
  it('enrolls by setting, posting, then reading the enrollment key back', async () => {
    await sendIosSimulatorBiometricEvent(UDID, 'enroll')
    expect(notifyutilArgs()).toEqual([
      [
        'simctl',
        'spawn',
        UDID,
        'notifyutil',
        '-s',
        'com.apple.BiometricKit.enrollmentChanged',
        '1'
      ],
      ['simctl', 'spawn', UDID, 'notifyutil', '-p', 'com.apple.BiometricKit.enrollmentChanged'],
      ['simctl', 'spawn', UDID, 'notifyutil', '-g', 'com.apple.BiometricKit.enrollmentChanged']
    ])
    expect(execFileMock.mock.calls[0][0]).toBe('xcrun')
  })

  it('unenrolls with the same sequence and a zero value', async () => {
    await sendIosSimulatorBiometricEvent(UDID, 'unenroll')
    expect(notifyutilArgs()[0]).toContain('0')
  })

  it('fails loudly when the enrollment key does not keep the value it was set to', async () => {
    execFileMock.mockImplementation(
      (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
        const stdout = args[4] === '-g' ? `${args[5]} 0\n` : ''
        queueMicrotask(() => callback(null, stdout, ''))
      }
    )
    await expect(sendIosSimulatorBiometricEvent(UDID, 'enroll')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('posts the Face ID keys by default', async () => {
    await sendIosSimulatorBiometricEvent(UDID, 'match')
    await sendIosSimulatorBiometricEvent(UDID, 'nomatch')
    expect(notifyutilArgs()).toEqual([
      ['simctl', 'spawn', UDID, 'notifyutil', '-p', 'com.apple.BiometricKit_Sim.pearl.match'],
      ['simctl', 'spawn', UDID, 'notifyutil', '-p', 'com.apple.BiometricKit_Sim.pearl.nomatch']
    ])
  })

  it('posts the Touch ID keys for the touch biometry type', async () => {
    await sendIosSimulatorBiometricEvent(UDID, 'match', 'touch')
    await sendIosSimulatorBiometricEvent(UDID, 'nomatch', 'touch')
    expect(notifyutilArgs()).toEqual([
      ['simctl', 'spawn', UDID, 'notifyutil', '-p', 'com.apple.BiometricKit_Sim.fingerTouch.match'],
      [
        'simctl',
        'spawn',
        UDID,
        'notifyutil',
        '-p',
        'com.apple.BiometricKit_Sim.fingerTouch.nomatch'
      ]
    ])
  })

  it('never posts the BiometricKit_Simulator spelling, which does nothing', async () => {
    for (const action of ['enroll', 'unenroll', 'match', 'nomatch'] as const) {
      await sendIosSimulatorBiometricEvent(UDID, action, 'touch')
    }
    for (const args of notifyutilArgs()) {
      expect(args.join(' ')).not.toContain('BiometricKit_Simulator')
    }
  })

  it('keeps the enrollment key free of the _Sim suffix the match keys carry', async () => {
    await sendIosSimulatorBiometricEvent(UDID, 'enroll')
    for (const args of notifyutilArgs()) {
      expect(args).toContain('com.apple.BiometricKit.enrollmentChanged')
      expect(args.join(' ')).not.toContain('BiometricKit_Sim.')
    }
  })

  it('applies a spawn timeout', async () => {
    await sendIosSimulatorBiometricEvent(UDID, 'match')
    expect(execFileMock.mock.calls[0][2]).toMatchObject({ timeout: 15_000 })
  })

  it('refuses to spawn anything off macOS', async () => {
    platformMock.mockReturnValue('linux')
    await expect(sendIosSimulatorBiometricEvent(UDID, 'match')).rejects.toMatchObject({
      code: 'emulator_not_macos'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('reports a missing simctl as an actionable Xcode problem', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        const error = Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' })
        queueMicrotask(() => callback(error, '', ''))
      }
    )
    await expect(sendIosSimulatorBiometricEvent(UDID, 'match')).rejects.toMatchObject({
      code: 'emulator_simctl_unavailable'
    })
  })

  it('surfaces other spawn failures as emulator_error', async () => {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        queueMicrotask(() => callback(new Error('Invalid device state'), '', 'boot the device'))
      }
    )
    await expect(sendIosSimulatorBiometricEvent(UDID, 'match')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })
})
