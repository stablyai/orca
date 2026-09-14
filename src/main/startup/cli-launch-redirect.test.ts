import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getCliLaunchArgs, maybeRedirectCliLaunch } from './cli-launch-redirect'

const COMMAND_NAMES = ['project', 'serve', 'status', 'skills', 'worktree']

const linux = {
  resourcesPath: '/opt/Orca/resources',
  execPath: '/opt/Orca/orca-ide',
  get cliEntryPath(): string {
    return posix.join(this.resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  }
}
const windows = {
  resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources',
  execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
  get cliEntryPath(): string {
    return win32.join(this.resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  }
}

const linuxOptions = { platform: 'linux' as const, isPackaged: true, commandNames: COMMAND_NAMES }
const windowsOptions = { platform: 'win32' as const, isPackaged: true, commandNames: COMMAND_NAMES }

describe('CLI launch redirect: entry-path form', () => {
  it('detects a launch that received the unpacked CLI entrypoint', () => {
    expect(
      getCliLaunchArgs(
        [windows.execPath, windows.cliEntryPath.toUpperCase(), 'status', '--json'],
        windows.cliEntryPath,
        windowsOptions
      )
    ).toEqual(['status', '--json'])
  })

  it('ignores normal desktop launches', () => {
    expect(
      getCliLaunchArgs([windows.execPath, '--updated'], windows.cliEntryPath, windowsOptions)
    ).toBeNull()
  })

  it('ignores the entrypoint when it is only the executable itself (argv[0])', () => {
    expect(
      getCliLaunchArgs([windows.cliEntryPath, 'status'], windows.cliEntryPath, windowsOptions)
    ).toBeNull()
  })

  it('applies on Linux too', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, linux.cliEntryPath, 'status'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['status'])
  })

  it('strips injected Chromium switches before node-mode CLI arguments', () => {
    expect(
      getCliLaunchArgs(
        [
          linux.execPath,
          linux.cliEntryPath,
          '--no-sandbox',
          '--disable-gpu',
          '--disable-features=Vulkan',
          'status',
          '--json'
        ],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['status', '--json'])
    expect(
      getCliLaunchArgs(
        [linux.execPath, linux.cliEntryPath, '--disable-features', 'Vulkan', 'skills', 'get'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['skills', 'get'])
  })

  it('keeps user flags after the command and malformed boolean assignments', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, linux.cliEntryPath, 'status', '--disable-features=Vulkan'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['status', '--disable-features=Vulkan'])
    expect(
      getCliLaunchArgs(
        [linux.execPath, linux.cliEntryPath, '--no-sandbox=true', 'status'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['--no-sandbox=true', 'status'])
  })

  it('does not treat a later positional entrypoint path as the launcher', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, 'file', 'open', '--path', linux.cliEntryPath],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toBeNull()
  })
})

describe('CLI launch redirect: command form', () => {
  it('redirects a direct binary launch with no AppImage env at all', () => {
    expect(
      getCliLaunchArgs(
        ['/home/u/.config/orca-runtime/versions/1.4.158/orca-ide', 'skills', 'get', '--full'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['skills', 'get', '--full'])
  })

  it('strips Chromium switches node mode would reject', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, '--no-sandbox', '--disable-gpu', 'status', '--json'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['status', '--json'])
  })

  it('preserves desktop-shaped switches after the command', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, 'skills', 'get', '--disable-gpu', '--no-sandbox'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['skills', 'get', '--disable-gpu', '--no-sandbox'])
  })

  it('leaves direct serve in-process but redirects its help', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, '--no-sandbox', 'serve', '--port', '6768'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toBeNull()
    expect(
      getCliLaunchArgs(
        [linux.execPath, '--no-sandbox', 'serve', '--help'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['serve', '--help'])
    expect(
      getCliLaunchArgs(
        [linux.execPath, '--disable-features', 'Vulkan', 'serve', '--help'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['serve', '--help'])
  })

  it('treats help as a CLI launch even without a command', () => {
    expect(getCliLaunchArgs([linux.execPath, '--help'], linux.cliEntryPath, linuxOptions)).toEqual([
      '--help'
    ])
  })

  it.each(['--version', '-v'])('treats %s as a CLI launch even without a command', (flag) => {
    expect(getCliLaunchArgs([linux.execPath, flag], linux.cliEntryPath, linuxOptions)).toEqual([
      flag
    ])
  })

  it.each(['--user-data-dir', '--proxy-server', '--unknown-desktop-switch'])(
    'does not treat a value of %s as a CLI early-exit flag',
    (flag) => {
      expect(
        getCliLaunchArgs([linux.execPath, flag, 'help'], linux.cliEntryPath, linuxOptions)
      ).toBeNull()
    }
  )

  it('does not treat a serve option value as a help request', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, 'serve', '--project-root', 'help'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toBeNull()
  })

  it('does not reinterpret help after the argument terminator', () => {
    expect(
      getCliLaunchArgs([linux.execPath, 'serve', '--', '--help'], linux.cliEntryPath, linuxOptions)
    ).toBeNull()
  })

  it('leaves a plain desktop launch alone', () => {
    expect(getCliLaunchArgs([linux.execPath], linux.cliEntryPath, linuxOptions)).toBeNull()
    expect(
      getCliLaunchArgs([linux.execPath, '/home/u/project'], linux.cliEntryPath, linuxOptions)
    ).toBeNull()
  })

  it('skips flag values when looking for the command positional', () => {
    expect(
      getCliLaunchArgs(
        [linux.execPath, '--environment', 'status', 'worktree', 'ps'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toEqual(['--environment', 'status', 'worktree', 'ps'])
    expect(
      getCliLaunchArgs(
        [linux.execPath, '--environment', 'status'],
        linux.cliEntryPath,
        linuxOptions
      )
    ).toBeNull()
  })

  it.each([
    ['--project', 'github:stablyai/orca', 'project', 'setups'],
    ['--project=github:stablyai/orca', 'project', 'setups'],
    ['--project', 'project', 'project', 'setups'],
    ['--project=project', 'project', 'setups']
  ])('preserves a project selector in %j', (...args) => {
    expect(getCliLaunchArgs([linux.execPath, ...args], linux.cliEntryPath, linuxOptions)).toEqual(
      args
    )
  })

  it('does not apply the command form on macOS or Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        getCliLaunchArgs([linux.execPath, 'status'], linux.cliEntryPath, {
          platform,
          isPackaged: true,
          commandNames: COMMAND_NAMES
        })
      ).toBeNull()
    }
  })

  it('never redirects an unpackaged build', () => {
    expect(
      getCliLaunchArgs([linux.execPath, 'status'], linux.cliEntryPath, {
        ...linuxOptions,
        isPackaged: false
      })
    ).toBeNull()
  })
})

describe('CLI launch redirect: spawning', () => {
  it('runs the in-package CLI in Electron node mode with sanitized env', () => {
    const run = vi.fn((..._args: unknown[]) => ({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    }))

    const result = maybeRedirectCliLaunch({
      argv: [linux.execPath, 'status', '--json'],
      env: { NODE_OPTIONS: '--inspect', NODE_REPL_EXTERNAL_MODULE: 'external-loader' },
      platform: 'linux',
      isPackaged: true,
      resourcesPath: linux.resourcesPath,
      execPath: linux.execPath,
      commandNames: COMMAND_NAMES,
      exists: () => true,
      run: run as never
    })

    expect(result).toEqual({ redirected: true, status: 0 })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: linux.execPath,
        args: [linux.cliEntryPath, 'status', '--json'],
        stdio: 'inherit',
        timeoutMs: null,
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          ORCA_CLI_LAUNCH_REDIRECTED: '1',
          ORCA_NODE_OPTIONS: '--inspect',
          ORCA_NODE_REPL_EXTERNAL_MODULE: 'external-loader'
        })
      })
    )
    const spawnedEnv = (run.mock.calls[0][0] as { env: NodeJS.ProcessEnv }).env
    expect(spawnedEnv).not.toHaveProperty('NODE_OPTIONS')
    expect(spawnedEnv).not.toHaveProperty('NODE_REPL_EXTERNAL_MODULE')
  })

  it('refuses to redirect twice so a dropped ELECTRON_RUN_AS_NODE cannot loop', () => {
    const run = vi.fn()

    const result = maybeRedirectCliLaunch({
      argv: [linux.execPath, 'status'],
      env: { ORCA_CLI_LAUNCH_REDIRECTED: '1' },
      platform: 'linux',
      isPackaged: true,
      resourcesPath: linux.resourcesPath,
      execPath: linux.execPath,
      commandNames: COMMAND_NAMES,
      exists: () => true,
      run: run as never
    })

    expect(result).toEqual({ redirected: true, status: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a missing CLI entrypoint instead of booting the desktop app', () => {
    const run = vi.fn()

    const result = maybeRedirectCliLaunch({
      argv: [linux.execPath, 'status'],
      env: {},
      platform: 'linux',
      isPackaged: true,
      resourcesPath: linux.resourcesPath,
      execPath: linux.execPath,
      commandNames: COMMAND_NAMES,
      exists: () => false,
      run: run as never
    })

    expect(result).toEqual({ redirected: true, status: 1 })
    expect(run).not.toHaveBeenCalled()
  })

  it('surfaces a spawn failure as a non-zero exit', () => {
    const result = maybeRedirectCliLaunch({
      argv: [linux.execPath, 'status'],
      env: {},
      platform: 'linux',
      isPackaged: true,
      resourcesPath: linux.resourcesPath,
      execPath: linux.execPath,
      commandNames: COMMAND_NAMES,
      exists: () => true,
      run: (() => {
        throw new Error('spawn ENOENT')
      }) as never
    })

    expect(result).toEqual({ redirected: true, status: 1 })
  })
})
