import { win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getPackagedCliEntryArgs,
  maybeRedirectPackagedCliEntryLaunch
} from './packaged-cli-entry-redirect'

const resourcesPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources'
const cliEntryPath = win32.join(resourcesPath, 'app.asar.unpacked', 'out', 'cli', 'index.js')

describe('packaged CLI entry redirect', () => {
  it('detects Windows GUI launches that received the unpacked CLI entrypoint', () => {
    expect(
      getPackagedCliEntryArgs(
        [
          'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
          cliEntryPath.toUpperCase(),
          'status',
          '--json'
        ],
        cliEntryPath,
        'win32'
      )
    ).toEqual(['status', '--json'])
  })

  it('ignores normal desktop launches', () => {
    expect(
      getPackagedCliEntryArgs(
        ['C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe', '--updated'],
        cliEntryPath,
        'win32'
      )
    ).toBeNull()
  })

  it('spawns the CLI in Electron node mode before the single-instance lock can win', () => {
    const spawn = vi.fn((..._args: unknown[]) => ({ status: 0 }))

    const result = maybeRedirectPackagedCliEntryLaunch({
      argv: [
        'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
        cliEntryPath,
        'status',
        '--json'
      ],
      env: {
        NODE_OPTIONS: '--inspect',
        NODE_REPL_EXTERNAL_MODULE: 'external-loader'
      },
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
      exists: () => true,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: true, status: 0 })
    expect(spawn).toHaveBeenCalledWith(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
      [cliEntryPath, 'status', '--json'],
      {
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          ORCA_PACKAGED_CLI_ENTRY_REDIRECTED: '1',
          ORCA_NODE_OPTIONS: '--inspect',
          ORCA_NODE_REPL_EXTERNAL_MODULE: 'external-loader'
        }),
        stdio: 'inherit'
      }
    )
    const spawnOptions = spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv } | undefined
    expect(spawnOptions?.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spawnOptions?.env).not.toHaveProperty('NODE_REPL_EXTERNAL_MODULE')
  })

  it('does not redirect development launches', () => {
    const spawn = vi.fn()

    const result = maybeRedirectPackagedCliEntryLaunch({
      argv: ['C:\\dev\\Orca.exe', cliEntryPath, 'status'],
      platform: 'win32',
      isPackaged: false,
      resourcesPath,
      execPath: 'C:\\dev\\Orca.exe',
      exists: () => true,
      spawn: spawn as never
    })

    expect(result).toEqual({ redirected: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fails clearly instead of recursively redirecting when node mode already failed once', () => {
    const spawn = vi.fn()
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    try {
      const result = maybeRedirectPackagedCliEntryLaunch({
        argv: [
          'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
          cliEntryPath,
          'status',
          '--json'
        ],
        env: {
          ORCA_PACKAGED_CLI_ENTRY_REDIRECTED: '1'
        },
        platform: 'win32',
        isPackaged: true,
        resourcesPath,
        execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\Orca.exe',
        exists: () => true,
        spawn: spawn as never
      })

      expect(result).toEqual({ redirected: true, status: 1 })
      expect(stderrWrite).toHaveBeenCalledWith(
        'Unable to start the Orca CLI through Electron node mode.\n'
      )
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      stderrWrite.mockRestore()
    }
  })
})
