import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  hasAntigravityLinuxSecretService,
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

  it('treats missing gdbus or headless D-Bus errors as unavailable Secret Service while preserving secret-tool errors when unlocked', async () => {
    expect(typeof hasAntigravityLinuxSecretService).toBe('function')

    vi.mocked(runProcess).mockRejectedValueOnce(
      Object.assign(new Error('spawn gdbus ENOENT'), { code: 'ENOENT' })
    )
    await expect(readAntigravityLinuxCredential()).resolves.toBeNull()

    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 1,
      signal: null,
      stdout: '',
      stderr:
        'Error spawning command line ‘dbus-launch’: Cannot autolaunch D-Bus without X11 $DISPLAY',
      timedOut: false
    })
    await expect(readAntigravityLinuxCredential()).resolves.toBeNull()

    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'Could not connect: Connection refused',
      timedOut: false
    })
    await expect(
      hasAntigravityLinuxSecretService({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/missing' })
    ).resolves.toBe(false)

    // Once Secret Service responds unlocked, missing secret-tool must still surface the actionable error.
    vi.mocked(runProcess)
      .mockResolvedValueOnce(collections)
      .mockResolvedValueOnce(unlocked)
      .mockRejectedValueOnce(
        Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' })
      )
    await expect(readAntigravityLinuxCredential()).rejects.toThrow('needs secret-tool')
  })
})
