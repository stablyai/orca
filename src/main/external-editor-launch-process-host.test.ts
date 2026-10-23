import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delimiter } from 'node:path'

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

  // Why spaces on both sides: a plain `cmd /c` strips the outer quotes once a spaced code.cmd
  // path meets a spaced argument, so the launch dies with "path not found" (seen on Windows 11).
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
  const mount = '/tmp/.mount_orca123'
  const executableSpec: ExternalEditorLaunchSpec = {
    kind: 'executable',
    hideWindowsConsole: true,
    spawnCmd: '/usr/bin/code',
    spawnArgs: ['/home/ada/project']
  }
  const shellSpec: ExternalEditorLaunchSpec = {
    kind: 'shell',
    hideWindowsConsole: true,
    spawnCmd: '/bin/sh',
    spawnArgs: ['-c', 'code --new-window /home/ada/project']
  }

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(spawnedChild)
    vi.stubEnv('APPIMAGE', '/data/apps/orca.appimage')
    vi.stubEnv('APPDIR', mount)
    vi.stubEnv('ARGV0', '/data/apps/orca.appimage')
    vi.stubEnv('OWD', '/home/ada')
    vi.stubEnv('APPIMAGE_LIBRARY_PATH', `${mount}/usr/lib`)
    vi.stubEnv('PATH', [mount, `${mount}/usr/sbin`, '/usr/bin'].join(delimiter))
    vi.stubEnv('LD_LIBRARY_PATH', [`${mount}/usr/lib`, '/opt/audio/lib'].join(delimiter))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  function spawnedEnv(): NodeJS.ProcessEnv | undefined {
    const options: { env?: NodeJS.ProcessEnv } | undefined = spawnMock.mock.calls[0]?.[2]
    return options?.env
  }

  it.each([
    ['executable', executableSpec],
    ['shell', shellSpec]
  ] as const)('strips the AppImage runtime env from a Linux %s launch', async (_kind, spec) => {
    setPlatform('linux')
    await launchExternalEditor(spec)
    const env = spawnedEnv()
    for (const key of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'APPIMAGE_LIBRARY_PATH']) {
      expect(env).not.toHaveProperty(key)
    }
    expect(env).toMatchObject({ PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/audio/lib' })
    expect(process.env.ARGV0).toBe('/data/apps/orca.appimage')
  })

  it('leaves the inherited env untouched on macOS', async () => {
    setPlatform('darwin')
    await launchExternalEditor(executableSpec)
    expect(spawnedEnv()).toBeUndefined()
  })
})
