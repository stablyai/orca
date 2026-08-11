import { EventEmitter } from 'node:events'
import { posix } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  MAIN_PROCESS_BOOTSTRAP_FILE,
  MAIN_PROCESS_COMPILE_CACHE_DIRECTORY,
  MAIN_PROCESS_DEVELOPMENT_CACHE_PARENT_DIRECTORY,
  createMainProcessBootstrap
} from './main-process-bootstrap'
import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'

function runBootstrap(options: {
  appImagePath?: string
  compileCacheSupported?: boolean
  devUserDataPath?: string
  enableCompileCache?: (directory: string) => unknown
  getUserDataPath?: () => string
  isPackaged?: boolean
  loadMain?: () => unknown
  nodeCompileCache?: string
  platform?: NodeJS.Platform
  startupDiagnostics?: '1' | 'trace'
}): { exports: unknown; timeline: string[] } {
  const timeline: string[] = []
  const processMock = new EventEmitter() as EventEmitter & {
    argv: string[]
    env: Record<string, string>
    execPath: string
    exit: (code: number) => void
    exitCode?: number
    pid: number
    platform: NodeJS.Platform
    ppid: number
  }
  processMock.argv = []
  processMock.env = {
    ...(options.nodeCompileCache ? { NODE_COMPILE_CACHE: options.nodeCompileCache } : {}),
    ...(options.devUserDataPath ? { ORCA_DEV_USER_DATA_PATH: options.devUserDataPath } : {}),
    ...(options.appImagePath ? { APPIMAGE: options.appImagePath } : {}),
    ...(options.startupDiagnostics ? { ORCA_STARTUP_DIAGNOSTICS: options.startupDiagnostics } : {})
  }
  processMock.execPath = '/electron'
  processMock.exit = () => {}
  processMock.pid = 42
  processMock.platform = options.platform ?? 'darwin'
  processMock.ppid = 7
  const moduleMock = { exports: undefined as unknown }
  const compileCacheModule =
    options.compileCacheSupported === false
      ? {}
      : {
          enableCompileCache: (directory: string) => {
            timeline.push(`enable:${directory}`)
            return options.enableCompileCache?.(directory)
          }
        }
  const requireMock = (specifier: string): unknown => {
    if (specifier === 'node:module') {
      return compileCacheModule
    }
    if (specifier === 'node:path') {
      return posix
    }
    if (specifier === 'node:fs') {
      return {
        writeSync: (_descriptor: number, message: string) => {
          timeline.push(`diagnostic:${message.trim()}`)
        }
      }
    }
    if (specifier === 'electron') {
      return {
        app: {
          getPath: options.getUserDataPath ?? (() => '/user-data'),
          isPackaged: options.isPackaged ?? true
        }
      }
    }
    if (specifier === './index.js') {
      timeline.push('main')
      return options.loadMain?.() ?? { loaded: true }
    }
    throw new Error(`Unexpected require: ${specifier}`)
  }

  runInNewContext(createMainProcessBootstrap(), {
    __dirname: '/repo/out/main',
    globalThis: {},
    module: moduleMock,
    process: processMock,
    require: requireMock,
    setImmediate: () => {}
  })
  return { exports: moduleMock.exports, timeline }
}

describe('main-process bootstrap', () => {
  it('installs fatal and diagnostic guards before cache setup and the real bundle', () => {
    const source = createMainProcessBootstrap()

    expect(source.indexOf(BOOTSTRAP_FATAL_EXIT_GUARD_KEY)).toBeLessThan(
      source.indexOf('ORCA_STARTUP_DIAGNOSTICS')
    )
    expect(source.indexOf('ORCA_STARTUP_DIAGNOSTICS')).toBeLessThan(
      source.indexOf('enableCompileCache')
    )
    expect(source.indexOf('enableCompileCache')).toBeLessThan(source.indexOf('./index.js'))
    expect(MAIN_PROCESS_BOOTSTRAP_FILE).toBe('bootstrap.cjs')
  })

  it('enables the compile cache before the real main bundle', () => {
    const result = runBootstrap({})

    expect(result.timeline).toEqual([
      `enable:/user-data/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`,
      'main'
    ])
    expect(result.exports).toEqual({ loaded: true })
  })

  it.each<NodeJS.Platform>(['darwin', 'win32', 'linux'])(
    'enables the cache on supported %s launches',
    (platform) => {
      const result = runBootstrap({ platform })

      expect(result.timeline[0]).toBe(`enable:/user-data/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`)
    }
  )

  it('skips the path-keyed cache for Linux AppImage launches', () => {
    const result = runBootstrap({
      appImagePath: '/tmp/.mount_Orca123/orca',
      nodeCompileCache: '/user-data/v8-compile-cache',
      platform: 'linux'
    })

    expect(result.timeline).toEqual(['main'])
    expect(result.exports).toEqual({ loaded: true })
  })

  it('preserves startup diagnostics before cache setup', () => {
    const result = runBootstrap({ startupDiagnostics: '1' })

    expect(result.timeline[0]).toContain('diagnostic:[bootstrap] bundle-enter chunk="index.js"')
    expect(result.timeline[1]).toBe(`enable:/user-data/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`)
  })

  it('respects Node compile-cache directory configuration', () => {
    const result = runBootstrap({ nodeCompileCache: '/configured-cache' })

    expect(result.timeline[0]).toBe('enable:/configured-cache')
  })

  it('uses a generated source-local cache for default development launches', () => {
    const result = runBootstrap({
      getUserDataPath: () => {
        throw new Error('development cache must not use shared app data')
      },
      isPackaged: false
    })

    expect(result.timeline[0]).toBe(
      `enable:/repo/out/${MAIN_PROCESS_DEVELOPMENT_CACHE_PARENT_DIRECTORY}/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`
    )
  })

  it('keeps explicit development user-data overrides authoritative', () => {
    const result = runBootstrap({
      devUserDataPath: '/configured-dev-profile',
      isPackaged: false
    })

    expect(result.timeline[0]).toBe(
      `enable:/configured-dev-profile/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`
    )
  })

  it('launches when the cache directory is read-only', () => {
    const result = runBootstrap({
      enableCompileCache: () => ({ status: 0, message: 'permission denied' })
    })

    expect(result.timeline).toContain('main')
    expect(result.exports).toEqual({ loaded: true })
  })

  it('launches when cache-directory resolution is unavailable', () => {
    const result = runBootstrap({
      getUserDataPath: () => {
        throw new Error('userData unavailable')
      }
    })

    expect(result.timeline).toEqual(['main'])
    expect(result.exports).toEqual({ loaded: true })
  })

  it('launches when the compile-cache API is unavailable', () => {
    const result = runBootstrap({ compileCacheSupported: false })

    expect(result.timeline).toEqual(['main'])
    expect(result.exports).toEqual({ loaded: true })
  })

  it('does not hide a real-main failure behind cache persistence', () => {
    expect(() =>
      runBootstrap({
        loadMain: () => {
          throw new Error('main failed')
        }
      })
    ).toThrow('main failed')
  })

  it('relies on Node exit persistence instead of a synchronous flush timer', () => {
    const source = createMainProcessBootstrap()

    expect(source).not.toContain('flushCompileCache')
    expect(source).not.toContain('setTimeout')
  })
})
