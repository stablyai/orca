import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { encodeAntigravityKeychainValue } from './native-credential-codec'
import {
  readAntigravityMacOSCredential,
  writeAntigravityMacOSCredential
} from './native-macos-credentials'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const contents = JSON.stringify({ auth_method: 'consumer', token: { access_token: 'synthetic' } })
const success: ProcessResult = {
  code: 0,
  signal: null,
  stdout: encodeAntigravityKeychainValue(contents),
  stderr: '',
  timedOut: false
}

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.mocked(runProcess).mockReset().mockResolvedValue(success)
})

afterEach(() => vi.restoreAllMocks())

describe('Antigravity macOS credential access', () => {
  it('reads only the native agy item', async () => {
    expect((await readAntigravityMacOSCredential())?.contents).toBe(contents)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        timeoutMs: 3000
      })
    )
  })

  it('distinguishes a missing item from denied, timed-out or clipped reads', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({ ...success, code: 44, stdout: '' })
    expect(await readAntigravityMacOSCredential()).toBeNull()
    for (const failure of [{ code: 36 }, { timedOut: true }, { outputTruncated: true }]) {
      vi.mocked(runProcess).mockResolvedValueOnce({ ...success, ...failure })
      await expect(readAntigravityMacOSCredential()).rejects.toThrow('could not be read')
    }
  })

  it('never exposes child-process exception output', async () => {
    vi.mocked(runProcess).mockRejectedValue(new Error('synthetic-secret'))
    await expect(readAntigravityMacOSCredential()).rejects.toThrow(
      'The Antigravity macOS credential store could not be accessed.'
    )
  })

  it('writes credentials through stdin and verifies the complete native blob', async () => {
    await writeAntigravityMacOSCredential(contents)
    expect(runProcess).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: ['-i'],
        input: `add-generic-password -U -s gemini -a antigravity -w ${encodeAntigravityKeychainValue(contents)}\n`
      })
    )
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('does not claim a successful switch when readback differs', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce({
        ...success,
        stdout: encodeAntigravityKeychainValue(contents.replace('synthetic', 'another'))
      })
    await expect(writeAntigravityMacOSCredential(contents)).rejects.toThrow('could not be verified')
  })

  it('rejects oversized writes before touching the active login', async () => {
    const large = contents.replace('synthetic', 'x'.repeat(4096))
    await expect(writeAntigravityMacOSCredential(large)).rejects.toThrow('command limit')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)(
    'does not answer for a different host (%s)',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      await expect(readAntigravityMacOSCredential()).rejects.toThrow('unavailable on this host')
      await expect(writeAntigravityMacOSCredential(contents)).rejects.toThrow(
        'unavailable on this host'
      )
      expect(runProcess).not.toHaveBeenCalled()
    }
  )
})
