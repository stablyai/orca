import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  launchExternalEditor,
  resolveVsCodeRemoteSshLaunchSpec,
  type ExternalEditorLaunchSpec
} from './external-editor-launch'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function spawnedChild(): { once: unknown; off: unknown; unref: unknown } {
  const child = {
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'spawn') {
        queueMicrotask(callback)
      }
      return child
    }),
    off: vi.fn(() => child),
    unref: vi.fn()
  }
  return child
}

function remoteSpec(
  code: string,
  path: string,
  platform: NodeJS.Platform
): ExternalEditorLaunchSpec {
  const spec = resolveVsCodeRemoteSshLaunchSpec(code, path, 'builder', {
    platform,
    fileExists: () => true
  })
  if (!spec) {
    throw new Error('expected a VS Code launch spec')
  }
  return spec
}

const HIDDEN_FIELDS = { detached: true, stdio: 'ignore', windowsHide: true, shell: false }
const HIDDEN = expect.objectContaining(HIDDEN_FIELDS)

describe('VS Code Remote-SSH launch through @orca/process-host', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(spawnedChild)
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it.each([
    ['darwin', '/usr/local/bin/code'],
    ['linux', '/usr/bin/code']
  ] as const)(
    'starts code directly on %s with a hidden, detached child',
    async (platform, code) => {
      setPlatform(platform)
      await launchExternalEditor(remoteSpec(code, '/home/ada/my project', platform))
      expect(spawnMock).toHaveBeenCalledWith(
        code,
        ['--remote', 'ssh-remote+builder', '/home/ada/my project'],
        HIDDEN
      )
    }
  )

  // A plain cmd /c loses quotes when both the launcher path and its argument contain spaces.
  it('keeps a spaced code.cmd path and a spaced remote path intact on Windows', async () => {
    setPlatform('win32')
    const codeCmd = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'
    await launchExternalEditor(remoteSpec(codeCmd, '/home/ada/my project', 'win32'))
    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(/cmd(\.exe)?$/i),
      [`/d /v:off /s /c ""${codeCmd}" "--remote" "ssh-remote+builder" "/home/ada/my project""`],
      expect.objectContaining({ ...HIDDEN_FIELDS, windowsVerbatimArguments: true })
    )
  })

  it('quotes cmd metacharacters in a remote path instead of letting cmd run them', async () => {
    setPlatform('win32')
    await launchExternalEditor(remoteSpec('C:\\Tools\\code.cmd', '/srv/a&whoami %OS%', 'win32'))
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      [
        String.raw`/d /v:off /s /c ""C:\Tools\code.cmd" "--remote" "ssh-remote+builder" "/srv/a&whoami "^%"OS"^%"""`
      ],
      expect.objectContaining({ ...HIDDEN_FIELDS, windowsVerbatimArguments: true })
    )
  })

  it('keeps the console of a Windows terminal editor visible', async () => {
    setPlatform('win32')
    await launchExternalEditor({
      kind: 'executable',
      hideWindowsConsole: false,
      spawnCmd: 'C:\\Tools\\nvim.exe',
      spawnArgs: ['C:\\work']
    })
    expect(spawnMock).toHaveBeenCalledWith('C:\\Tools\\nvim.exe', ['C:\\work'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
  })
})

describe('external editor launch environment', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(spawnedChild)
    vi.stubEnv('APPDIR', '/tmp/.mount_orca123')
    vi.stubEnv('ARGV0', '/data/apps/orca.appimage')
    vi.stubEnv('ORCA_EDITOR_ENV_PROBE', 'kept')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it.each([
    [
      'shell',
      (): ExternalEditorLaunchSpec => ({
        kind: 'shell',
        hideWindowsConsole: true,
        spawnCmd: '/bin/sh',
        spawnArgs: ['-c', 'code --new-window /home/ada/project']
      })
    ],
    ['Remote-SSH', () => remoteSpec('/usr/bin/code', '/home/ada/project', 'linux')]
  ] as const)('strips the AppImage runtime env from a Linux %s launch', async (_kind, spec) => {
    setPlatform('linux')
    await launchExternalEditor(spec())
    const options: { env?: NodeJS.ProcessEnv } | undefined = spawnMock.mock.calls[0]?.[2]
    expect(options?.env).not.toHaveProperty('ARGV0')
    expect(options?.env).toMatchObject({ ORCA_EDITOR_ENV_PROBE: 'kept' })
    expect(process.env.ARGV0).toBe('/data/apps/orca.appimage')
  })
})
