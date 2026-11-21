import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  readAntigravityLinuxCredential,
  writeAntigravityLinuxCredential
} from './native-linux-credentials'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('node:fs/promises', () => ({ stat: vi.fn(async () => ({})) }))

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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Antigravity Linux keyring access', () => {
  it('refuses a locked keyring without triggering a secret-tool unlock prompt', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce(collections)
      .mockResolvedValueOnce(ok('(<true>,)\n'))
    await expect(readAntigravityLinuxCredential()).rejects.toThrow('keyring is locked')
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('reports no keyring item where agy falls back to its token file, but not on a timeout', async () => {
    const failed = (stderr: string): ProcessResult => ({ ...ok(), code: 1, stderr })
    // A system service for a lingering user: the bus socket exists but the env doesn't name it.
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', '')
    vi.mocked(runProcess).mockResolvedValueOnce(
      failed('Error connecting: Cannot autolaunch D-Bus without X11 $DISPLAY\n')
    )
    await expect(readAntigravityLinuxCredential()).resolves.toBeNull()
    // agy's godbus finds that socket, so the probe asks the same bus.
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus`,
          LC_ALL: 'C'
        })
      })
    )
    // gnome-keyring on a host nobody logs in to holds only the session collection.
    vi.mocked(runProcess)
      .mockResolvedValueOnce(
        ok("(<[objectpath '/org/freedesktop/secrets/collection/session']>,)\n")
      )
      .mockResolvedValueOnce(
        failed(
          'Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Object does not exist at path “/org/freedesktop/secrets/collection/login”\n'
        )
      )
    await expect(readAntigravityLinuxCredential()).resolves.toBeNull()
    expect(runProcess).toHaveBeenCalledTimes(3)

    vi.mocked(runProcess).mockResolvedValueOnce(failed('Error: Timeout was reached\n'))
    await expect(readAntigravityLinuxCredential()).rejects.toThrow('did not respond')
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
})
