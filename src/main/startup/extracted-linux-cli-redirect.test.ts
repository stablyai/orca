import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getExtractedLinuxCliArgs,
  maybeRedirectExtractedLinuxCliLaunch
} from './extracted-linux-cli-redirect'

const commandNames = ['serve', 'skills', 'orchestration', 'status']

describe('extracted-tree Linux CLI redirect', () => {
  it('detects a headless CLI command on the extracted runtime binary', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', 'skills', 'get', 'orchestration', '--full'],
        {},
        { platform: 'linux', isPackaged: true, commandNames }
      )
    ).toEqual(['skills', 'get', 'orchestration', '--full'])
  })

  it('allows CLI global flags before the command', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', '--environment', 'prod', 'orchestration', 'send'],
        {},
        { platform: 'linux', isPackaged: true, commandNames }
      )
    ).toEqual(['--environment', 'prod', 'orchestration', 'send'])
  })

  it('strips a --no-sandbox desktop flag before forwarding the CLI command', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', '--no-sandbox', 'orchestration'],
        {},
        { platform: 'linux', isPackaged: true, commandNames }
      )
    ).toEqual(['orchestration'])
  })

  it('does not redirect `serve` — it keeps its own Electron launch and sandbox', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', 'serve', '--port', '6768'],
        {},
        { platform: 'linux', isPackaged: true, commandNames }
      )
    ).toBeNull()
  })

  it('does not redirect a GUI launch with no CLI command', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', '--no-sandbox', 'file:///tmp/example.txt'],
        {},
        { platform: 'linux', isPackaged: true, commandNames }
      )
    ).toBeNull()
  })

  it('leaves node-mode launches alone (the CLI already runs directly)', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', 'orchestration'],
        { ELECTRON_RUN_AS_NODE: '1' },
        { platform: 'linux', isPackaged: true, commandNames }
      )
    ).toBeNull()
  })

  it('leaves AppImage launches to the AppImage redirect', () => {
    for (const env of [{ APPIMAGE: '/opt/orca.AppImage' }, { APPDIR: '/tmp/.mount_orca' }]) {
      expect(
        getExtractedLinuxCliArgs(['orca-ide', 'orchestration'], env, {
          platform: 'linux',
          isPackaged: true,
          commandNames
        })
      ).toBeNull()
    }
  })

  it('does not redirect on macOS or Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      expect(
        getExtractedLinuxCliArgs(['orca-ide', 'orchestration'], {}, {
          platform,
          isPackaged: true,
          commandNames
        })
      ).toBeNull()
    }
  })

  it('does not redirect an unpackaged build', () => {
    expect(
      getExtractedLinuxCliArgs(
        ['orca-ide', 'orchestration'],
        {},
        { platform: 'linux', isPackaged: false, commandNames }
      )
    ).toBeNull()
  })

  it('re-runs the CLI entrypoint in Electron node mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-extracted-cli-redirect-'))
    try {
      const cliEntryPath = join(root, 'app.asar.unpacked', 'out', 'cli', 'index.js')
      await mkdir(join(root, 'app.asar.unpacked', 'out', 'cli'), { recursive: true })
      await writeFile(cliEntryPath, '', 'utf8')
      const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))

      const result = maybeRedirectExtractedLinuxCliLaunch({
        argv: ['orca-ide', 'skills', 'get', 'orchestration', '--full'],
        env: { NODE_OPTIONS: '--inspect', NODE_REPL_EXTERNAL_MODULE: '/tmp/repl.js' },
        platform: 'linux',
        isPackaged: true,
        resourcesPath: root,
        execPath: '/home/orca/.config/orca-runtime/versions/1.4.158/orca-ide',
        commandNames,
        spawn: spawn as never
      })

      expect(result).toEqual({ redirected: true, status: 0 })
      expect(spawn).toHaveBeenCalledWith(
        '/home/orca/.config/orca-runtime/versions/1.4.158/orca-ide',
        [cliEntryPath, 'skills', 'get', 'orchestration', '--full'],
        {
          env: expect.objectContaining({
            ELECTRON_RUN_AS_NODE: '1',
            ORCA_NODE_OPTIONS: '--inspect',
            ORCA_NODE_REPL_EXTERNAL_MODULE: '/tmp/repl.js'
          }),
          stdio: 'inherit'
        }
      )
      const spawnOptions = spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv } | undefined
      expect(spawnOptions?.env).not.toHaveProperty('NODE_OPTIONS')
      expect(spawnOptions?.env).not.toHaveProperty('NODE_REPL_EXTERNAL_MODULE')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not redirect a native-install binary (only the extracted per-version tree)', () => {
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))
    const result = maybeRedirectExtractedLinuxCliLaunch({
      argv: ['orca-ide', 'status'],
      env: {},
      platform: 'linux',
      isPackaged: true,
      resourcesPath: '/opt/Orca/resources',
      // A deb/rpm install ships chrome-sandbox root:root 4755 — no SUID abort.
      execPath: '/opt/Orca/orca-ide',
      commandNames,
      exists: (() => true) as never,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not redirect a traversal path that escapes the version tree', () => {
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))
    const result = maybeRedirectExtractedLinuxCliLaunch({
      argv: ['orca-ide', 'status'],
      env: {},
      platform: 'linux',
      isPackaged: true,
      resourcesPath: '/whatever',
      // Resolves outside versions/ — a raw substring match would wrongly accept it.
      execPath: '/home/orca/.config/orca-runtime/versions/../native/orca-ide',
      commandNames,
      exists: (() => true) as never,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a missing CLI entrypoint without spawning', () => {
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))
    const result = maybeRedirectExtractedLinuxCliLaunch({
      argv: ['orca-ide', 'orchestration'],
      env: {},
      platform: 'linux',
      isPackaged: true,
      resourcesPath: '/nonexistent',
      execPath: '/home/orca/.config/orca-runtime/versions/1.4.158/orca-ide',
      commandNames,
      exists: (() => false) as never,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: true, status: 1 })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not redirect a GUI launch (returns redirected: false)', () => {
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))
    const result = maybeRedirectExtractedLinuxCliLaunch({
      argv: ['orca-ide'],
      env: {},
      platform: 'linux',
      isPackaged: true,
      resourcesPath: '/whatever',
      execPath: '/home/orca/.config/orca-runtime/versions/1.4.158/orca-ide',
      commandNames,
      exists: (() => true) as never,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: false })
    expect(spawn).not.toHaveBeenCalled()
  })
})
