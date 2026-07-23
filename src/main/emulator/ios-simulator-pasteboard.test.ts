import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Os from 'node:os'

const { execFileMock, platformMock, stdinEndMock, stdinOnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  platformMock: vi.fn(() => 'darwin'),
  stdinEndMock: vi.fn(),
  stdinOnMock: vi.fn()
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

import { EmulatorError } from './emulator-errors'
import { setIosSimulatorPasteboardText } from './ios-simulator-pasteboard'

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'
const SECRET_TEXT = 'token=secret🙂 안녕'

function fakeChild() {
  return { stdin: { end: stdinEndMock, on: stdinOnMock } }
}

describe('setIosSimulatorPasteboardText', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    platformMock.mockReset()
    platformMock.mockReturnValue('darwin')
    stdinEndMock.mockReset()
    stdinOnMock.mockReset()
  })

  it('pipes the text to simctl pbcopy via stdin, never argv', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, '', ''))
      return fakeChild()
    })

    await setIosSimulatorPasteboardText(UDID, SECRET_TEXT)

    const [command, args, options] = execFileMock.mock.calls[0]
    expect(command).toBe('xcrun')
    expect(args).toEqual(['simctl', 'pbcopy', UDID])
    expect(JSON.stringify(args)).not.toContain('secret')
    expect(stdinEndMock).toHaveBeenCalledWith(SECRET_TEXT, 'utf8')
    // A broken pipe must not crash the process while the callback error wins.
    expect(stdinOnMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(options.env.LC_ALL).toBe('en_US.UTF-8')
  })

  it('maps pbcopy failures without leaking the text', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error(`Command failed: xcrun simctl pbcopy ${UDID}`), { code: 1 }),
          '',
          'Invalid device state'
        )
      )
      return fakeChild()
    })

    const failure = await setIosSimulatorPasteboardText(UDID, SECRET_TEXT).catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(EmulatorError)
    expect((failure as EmulatorError).code).toBe('emulator_error')
    expect((failure as EmulatorError).message).not.toContain('secret')
    expect((failure as EmulatorError).message).not.toContain('안녕')
  })

  it('maps a missing simctl to the actionable Xcode error', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }), '', '')
      )
      return fakeChild()
    })

    await expect(setIosSimulatorPasteboardText(UDID, 'hello')).rejects.toMatchObject({
      code: 'emulator_simctl_unavailable'
    })
  })

  it('rejects off macOS without spawning anything', async () => {
    platformMock.mockReturnValue('linux')

    await expect(setIosSimulatorPasteboardText(UDID, 'hello')).rejects.toMatchObject({
      code: 'emulator_not_macos'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })
})
