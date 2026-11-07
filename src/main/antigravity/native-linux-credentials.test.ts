import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  readAntigravityLinuxCredential,
  writeAntigravityLinuxCredential
} from './native-linux-credentials'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

const contents = JSON.stringify({ auth_method: 'consumer', token: { access_token: 'synthetic' } })
const ok = (stdout = ''): ProcessResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})
const collections = ok(
  "(<[objectpath '/org/freedesktop/secrets/collection/login', '/org/freedesktop/secrets/collection/session']>,)\n"
)
const unlocked = ok('(<false>,)\n')

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.mocked(runProcess).mockReset()
})

afterEach(() => vi.restoreAllMocks())

describe('Antigravity Linux keyring access', () => {
  it('refuses a locked keyring without triggering a secret-tool unlock prompt', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce(collections)
      .mockResolvedValueOnce(ok('(<true>,)\n'))
    await expect(readAntigravityLinuxCredential()).rejects.toThrow('keyring is locked')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('reports no keyring credential when no Secret Service owns the bus', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      ...ok(),
      code: 1,
      stderr:
        'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files\n'
    })
    expect(await readAntigravityLinuxCredential()).toBeNull()
  })

  it('distinguishes a missing item from a failed lookup', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce(collections)
      .mockResolvedValueOnce(unlocked)
      .mockResolvedValueOnce({ ...ok(), code: 1 })
    expect(await readAntigravityLinuxCredential()).toBeNull()
    vi.mocked(runProcess)
      .mockResolvedValueOnce(collections)
      .mockResolvedValueOnce(unlocked)
      .mockResolvedValueOnce({ ...ok(), code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus' })
    await expect(readAntigravityLinuxCredential()).rejects.toThrow('could not be read')
  })

  it('replaces agy’s go-keyring item in its collection and verifies the readback', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce(collections)
      .mockResolvedValueOnce(unlocked)
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok(contents))
    await writeAntigravityLinuxCredential(contents)
    expect(runProcess).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        program: 'secret-tool',
        args: [
          'store',
          '--collection=/org/freedesktop/secrets/collection/login',
          "--label=Password for 'antigravity' on 'gemini'",
          'service',
          'gemini',
          'username',
          'antigravity'
        ],
        input: contents
      })
    )

    vi.mocked(runProcess)
      .mockResolvedValueOnce(ok("(<[objectpath '/org/freedesktop/secrets/collection/kdbx']>,)\n"))
      .mockResolvedValueOnce(unlocked)
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok(contents.replace('synthetic', 'another')))
    await expect(writeAntigravityLinuxCredential(contents)).rejects.toThrow('could not be verified')
    expect(runProcess).toHaveBeenNthCalledWith(
      7,
      expect.objectContaining({
        args: expect.arrayContaining(['--collection=/org/freedesktop/secrets/aliases/default'])
      })
    )
  })

  it('names the missing tool instead of leaking spawn errors', async () => {
    vi.mocked(runProcess).mockRejectedValueOnce(
      Object.assign(new Error('spawn gdbus ENOENT'), { code: 'ENOENT' })
    )
    await expect(readAntigravityLinuxCredential()).rejects.toThrow('needs gdbus')
  })
})
