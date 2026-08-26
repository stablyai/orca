import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAppImageCliArgs, maybeRedirectAppImageCliLaunch } from './appimage-cli-redirect'

const commandNames = ['serve', 'status', 'terminal']
const registeredCommandNamesMissingFromTheRedirect = [
  'account',
  'agent-context',
  'artifacts',
  'claude-teams',
  'diagnostics',
  'emulator',
  'linear',
  'project',
  'skills',
  'vm'
]
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function createCliFixture(): Promise<{ root: string; cliEntryPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-appimage-cli-redirect-'))
  temporaryRoots.push(root)
  const cliEntryPath = join(root, 'app.asar.unpacked', 'out', 'cli', 'index.js')
  await mkdir(join(root, 'app.asar.unpacked', 'out', 'cli'), { recursive: true })
  await writeFile(cliEntryPath, '', 'utf8')
  return { root, cliEntryPath }
}

describe('AppImage CLI redirect', () => {
  it('detects direct AppImage CLI commands', () => {
    expect(
      getAppImageCliArgs(
        ['orca-linux.AppImage', 'status', '--json'],
        { APPIMAGE: '/opt/orca' },
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toEqual(['status', '--json'])
  })

  it('detects packaged Linux CLI commands without AppImage runtime variables', () => {
    expect(
      getAppImageCliArgs(
        ['orca-ide', 'status', '--json'],
        {},
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toEqual(['status', '--json'])
  })

  it.each(['--version', '-v', '-V'])('detects the global version flag %s', (versionFlag) => {
    expect(
      getAppImageCliArgs(
        ['orca-linux.AppImage', versionFlag],
        { APPIMAGE: '/opt/orca' },
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toEqual([versionFlag])
  })

  it('preserves version-like arguments for registered passthrough commands', () => {
    expect(
      getAppImageCliArgs(
        ['orca-linux.AppImage', 'claude-teams', '--version'],
        { APPIMAGE: '/opt/orca' },
        { platform: 'linux', isPackaged: true, commandNames: ['claude-teams'] }
      )
    ).toEqual(['claude-teams', '--version'])
  })

  it.each(['darwin', 'win32'] as const)('does not redirect CLI commands on %s', (platform) => {
    expect(
      getAppImageCliArgs(['orca-ide', 'status'], {}, { platform, isPackaged: true, commandNames })
    ).toBeNull()
  })

  it('does not redirect unpackaged Linux commands', () => {
    expect(
      getAppImageCliArgs(
        ['electron', 'status'],
        {},
        { platform: 'linux', isPackaged: false, commandNames }
      )
    ).toBeNull()
  })

  it('keeps env-less serve on the in-process pre-GUI path', () => {
    for (const serveArgs of [
      ['serve', '--port', '6768'],
      ['serve', '--help']
    ]) {
      expect(
        getAppImageCliArgs(
          ['orca-ide', ...serveArgs],
          {},
          { platform: 'linux', isPackaged: true, commandNames }
        )
      ).toBeNull()
    }
  })

  it('allows CLI global flags before the command', () => {
    expect(
      getAppImageCliArgs(
        ['orca-linux.AppImage', '--pairing-code', 'abc123', '--json', 'terminal', 'list'],
        {
          APPIMAGE: '/opt/orca'
        },
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
      getAppImageCliArgs(
        ['AppRun', '--no-sandbox', 'file:///tmp/example.txt'],
        {
          APPIMAGE: '/opt/orca'
        },
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toBeNull()
  })

  it.each([['--user-data-dir', 'status'], ['--user-data-dir', 'help'], ['--user-data-dir=status']])(
    'does not redirect desktop launches with Electron profile args %s %s',
    (...profileArgs) => {
      expect(
        getAppImageCliArgs(
          ['orca-ide', ...profileArgs],
          {},
          { platform: 'linux', isPackaged: true, commandNames }
        )
      ).toBeNull()
    }
  )

  it('routes no-sandbox serve launches through the CLI', () => {
    expect(
      getAppImageCliArgs(
        ['AppRun', '--no-sandbox', 'serve', '--port', '6768'],
        { APPIMAGE: '/opt/orca' },
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toEqual(['serve', '--port', '6768'])
  })

  it('removes no-sandbox before forwarding CLI help', () => {
    expect(
      getAppImageCliArgs(
        ['AppRun', '--no-sandbox', 'serve', '--help'],
        { APPIMAGE: '/opt/orca' },
        {
          platform: 'linux',
          isPackaged: true,
          commandNames
        }
      )
    ).toEqual(['serve', '--help'])
  })

  it('spawns the unpacked CLI entrypoint with Electron node mode', async () => {
    const { root, cliEntryPath } = await createCliFixture()
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
    const { root, cliEntryPath } = await createCliFixture()
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

  it.each(registeredCommandNamesMissingFromTheRedirect)(
    'redirects the registered %s command with the production registry',
    async (commandName) => {
      const { root } = await createCliFixture()

      expect(
        maybeRedirectAppImageCliLaunch({
          argv: ['orca-linux.AppImage', commandName, '--json'],
          env: { APPIMAGE: '/opt/orca/orca-linux.AppImage' },
          platform: 'linux',
          isPackaged: true,
          resourcesPath: root,
          execPath: '/opt/orca/orca-ide',
          spawn: (() => ({ status: 0 })) as never
        })
      ).toEqual({ redirected: true, status: 0 })
    }
  )
})
