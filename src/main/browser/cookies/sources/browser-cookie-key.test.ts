import { pbkdf2Sync } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { getLinuxEncryptionKey } from './browser-cookie-key'

beforeEach(() => {
  runProcessMock.mockReset()
})

it.each([
  { code: 'ENOENT', stderr: '', failure: 'secret-tool-missing' },
  { code: 'EACCES', stderr: '', failure: 'key-unavailable' },
  { stderr: 'The collection is locked', failure: 'keyring-locked' },
  { stderr: 'Access denied', failure: 'keyring-locked' },
  { stderr: 'Prompt was dismissed', failure: 'keyring-locked' },
  { stderr: '', failure: 'key-unavailable' },
  { stderr: 'Service is not available', failure: 'key-unavailable' }
])(
  'retains the Linux lookup cause: $failure ($code / $stderr)',
  async ({ code, stderr, failure }) => {
    runProcessMock.mockImplementation(async () => {
      if (code) {
        throw Object.assign(new Error('spawn failed'), { code })
      }
      return { code: stderr ? 1 : 0, timedOut: false, stdout: '', stderr }
    })

    expect(await getLinuxEncryptionKey('Chrome Safe Storage', 'Chrome')).toEqual({
      mode: 'aes-128-cbc',
      keysByVersion: { v10: pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1') },
      keyringUnavailable: true,
      keyringFailure: failure
    })
  }
)

it('retains a v11 key from the application fallback after the first lookup fails', async () => {
  runProcessMock
    .mockResolvedValueOnce({ code: 1, timedOut: false, stdout: '', stderr: '' })
    .mockResolvedValueOnce({ code: 0, timedOut: false, stdout: 'fixture-secret\n', stderr: '' })

  expect(await getLinuxEncryptionKey('Chrome Safe Storage', 'Chrome')).toEqual({
    mode: 'aes-128-cbc',
    keysByVersion: {
      v10: pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'),
      v11: pbkdf2Sync('fixture-secret', 'saltysalt', 1, 16, 'sha1')
    }
  })
})
