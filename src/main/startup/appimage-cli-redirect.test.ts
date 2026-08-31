import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getAppImageCliArgs, maybeRedirectAppImageCliLaunch } from './appimage-cli-redirect'

const commandNames = ['serve', 'status', 'terminal']

describe('AppImage CLI redirect', () => {
  // Regression for #13004: electron-builder's AppRun sets APPDIR/APPIMAGE as shell locals it never
  // exports, and .deb installs have no AppRun at all, so the exec'd process sees neither. The
  // command-name allow-list already gates this launch, so the env check was a redundant condition
  // that silently blocked every extracted-AppImage and .deb CLI launch (getAppImageCliArgs no
  // longer takes an env argument at all).
  it('detects direct AppImage CLI commands', () => {
    expect(
      getAppImageCliArgs(['orca-linux.AppImage', 'status', '--json'], {
        platform: 'linux',
        isPackaged: true,
        commandNames
      })
    ).toEqual(['status', '--json'])
  })

  it('allows CLI global flags before the command', () => {
    expect(
      getAppImageCliArgs(
        ['orca-linux.AppImage', '--pairing-code', 'abc123', '--json', 'terminal', 'list'],
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toEqual(['--pairing-code', 'abc123', '--json', 'terminal', 'list'])
  })

  it('does not redirect normal desktop AppImage launches', () => {
    expect(
      getAppImageCliArgs(['AppRun', '--no-sandbox', 'file:///tmp/example.txt'], {
        platform: 'linux',
        isPackaged: true,
        commandNames
      })
    ).toBeNull()
  })

  it('routes no-sandbox serve launches through the CLI', () => {
    expect(
      getAppImageCliArgs(['AppRun', '--no-sandbox', 'serve', '--port', '6768'], {
        platform: 'linux',
        isPackaged: true,
        commandNames
      })
    ).toEqual(['serve', '--port', '6768'])
  })

  it('removes no-sandbox before forwarding CLI help', () => {
    expect(
      getAppImageCliArgs(['AppRun', '--no-sandbox', 'serve', '--help'], {
        platform: 'linux',
        isPackaged: true,
        commandNames
      })
    ).toEqual(['serve', '--help'])
  })

  it('spawns the unpacked CLI entrypoint with Electron node mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-appimage-cli-redirect-'))
    const cliEntryPath = join(root, 'app.asar.unpacked', 'out', 'cli', 'index.js')
    await mkdir(join(root, 'app.asar.unpacked', 'out', 'cli'), { recursive: true })
    await writeFile(cliEntryPath, '', 'utf8')
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))

    const result = maybeRedirectAppImageCliLaunch({
      argv: ['orca-linux.AppImage', 'status', '--json'],
      env: {
        APPIMAGE: '/opt/orca/orca-linux.AppImage',
        NODE_OPTIONS: '--inspect',
        NODE_REPL_EXTERNAL_MODULE: '/tmp/repl.js'
      },
      platform: 'linux',
      isPackaged: true,
      resourcesPath: root,
      execPath: '/opt/orca/orca-ide',
      commandNames,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: true, status: 0 })
    expect(spawn).toHaveBeenCalledWith('/opt/orca/orca-ide', [cliEntryPath, 'status', '--json'], {
      env: expect.objectContaining({
        APPIMAGE: '/opt/orca/orca-linux.AppImage',
        ELECTRON_RUN_AS_NODE: '1',
        ORCA_NODE_OPTIONS: '--inspect',
        ORCA_NODE_REPL_EXTERNAL_MODULE: '/tmp/repl.js'
      }),
      stdio: 'inherit'
    })
    const spawnOptions = spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv } | undefined
    expect(spawnOptions?.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spawnOptions?.env).not.toHaveProperty('NODE_REPL_EXTERNAL_MODULE')
  })

  it('forwards an explicit no-sandbox choice to the serve child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-appimage-cli-redirect-'))
    const cliEntryPath = join(root, 'app.asar.unpacked', 'out', 'cli', 'index.js')
    await mkdir(join(root, 'app.asar.unpacked', 'out', 'cli'), { recursive: true })
    await writeFile(cliEntryPath, '', 'utf8')
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))

    maybeRedirectAppImageCliLaunch({
      argv: ['orca-linux.AppImage', '--no-sandbox', 'serve'],
      env: { APPIMAGE: '/opt/orca/orca-linux.AppImage' },
      platform: 'linux',
      isPackaged: true,
      resourcesPath: root,
      execPath: '/opt/orca/orca-ide',
      commandNames,
      spawn: spawn as never
    })

    expect(spawn).toHaveBeenCalledWith(
      '/opt/orca/orca-ide',
      [cliEntryPath, 'serve'],
      expect.objectContaining({
        env: expect.objectContaining({ ORCA_APPIMAGE_NO_SANDBOX: '1' })
      })
    )
  })
})
