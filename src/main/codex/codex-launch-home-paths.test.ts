import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { fsMockState } = vi.hoisted(() => ({
  fsMockState: {
    failSymlink: false,
    hardLinkRace: false,
    failSqliteRead: false,
    readFilePaths: [] as string[]
  }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (fsMockState.hardLinkRace) {
        fsMockState.hardLinkRace = false
        actual.linkSync(...args)
        const error = new Error('target already linked') as NodeJS.ErrnoException
        error.code = 'EEXIST'
        throw error
      }
      return actual.linkSync(...args)
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const targetPath = String(args[0])
      fsMockState.readFilePaths.push(targetPath)
      if (
        fsMockState.failSqliteRead &&
        /(?:\.sqlite|\.sqlite-wal|\.sqlite-shm)$/.test(targetPath)
      ) {
        throw new Error(`unexpected sqlite content read: ${targetPath}`)
      }
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
    symlinkSync: (...args: Parameters<typeof actual.symlinkSync>) => {
      if (fsMockState.failSymlink) {
        throw new Error('symlink disabled for test')
      }
      return actual.symlinkSync(...args)
    }
  }
})

import { materializeScopedCodexLaunchHome } from './codex-launch-home-paths'

let tempDir: string
let sharedHomePath: string
let launchRootPath: string

function expectSameFile(targetPath: string, sourcePath: string): void {
  const targetStat = statSync(targetPath)
  const sourceStat = statSync(sourcePath)
  expect(targetStat.dev).toBe(sourceStat.dev)
  expect(targetStat.ino).toBe(sourceStat.ino)
  expect(targetStat.nlink).toBeGreaterThan(1)
}

function withWin32Platform<T>(callback: () => T): T {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return callback()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

beforeEach(() => {
  fsMockState.failSymlink = false
  fsMockState.hardLinkRace = false
  fsMockState.failSqliteRead = false
  fsMockState.readFilePaths = []
  tempDir = mkdtempSync(join(tmpdir(), 'orca-codex-launch-home-'))
  sharedHomePath = join(tempDir, 'shared-home')
  launchRootPath = join(tempDir, 'launch-root')
  mkdirSync(sharedHomePath, { recursive: true })
  mkdirSync(launchRootPath, { recursive: true })
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('materializeScopedCodexLaunchHome', () => {
  it('hard-links shared files when symlinks are unavailable', () => {
    fsMockState.failSymlink = true
    const hooksPath = join(sharedHomePath, 'hooks.json')
    const sqlitePath = join(sharedHomePath, 'logs_2.sqlite')
    const sqliteWalPath = join(sharedHomePath, 'logs_2.sqlite-wal')
    const sqliteShmPath = join(sharedHomePath, 'logs_2.sqlite-shm')
    writeFileSync(hooksPath, '{"hooks":{}}\n')
    writeFileSync(sqlitePath, 'sqlite\n')
    writeFileSync(sqliteWalPath, 'wal\n')
    writeFileSync(sqliteShmPath, 'shm\n')

    const launchHomePath = withWin32Platform(() =>
      materializeScopedCodexLaunchHome(sharedHomePath, launchRootPath, null)
    )

    for (const entryName of [
      'hooks.json',
      'logs_2.sqlite',
      'logs_2.sqlite-wal',
      'logs_2.sqlite-shm'
    ]) {
      const targetPath = join(launchHomePath, entryName)
      const sourcePath = join(sharedHomePath, entryName)
      expect(existsSync(targetPath)).toBe(true)
      expect(lstatSync(targetPath).isSymbolicLink()).toBe(false)
      expect(readFileSync(targetPath, 'utf-8')).toBe(readFileSync(sourcePath, 'utf-8'))
      expectSameFile(targetPath, sourcePath)
    }
  })

  it('accepts a shared file already linked by a concurrent materializer', () => {
    fsMockState.hardLinkRace = true
    const sourcePath = join(sharedHomePath, 'memories_1.sqlite-wal')
    writeFileSync(sourcePath, 'wal\n')

    const launchHomePath = withWin32Platform(() =>
      materializeScopedCodexLaunchHome(sharedHomePath, launchRootPath, null)
    )
    const targetPath = join(launchHomePath, 'memories_1.sqlite-wal')

    expect(existsSync(targetPath)).toBe(true)
    expect(lstatSync(targetPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(targetPath, 'utf-8')).toBe(readFileSync(sourcePath, 'utf-8'))
    expectSameFile(targetPath, sourcePath)
  })

  it('does not hash sqlite contents when marking shared database links', () => {
    const sourcePath = join(sharedHomePath, 'logs_2.sqlite')
    writeFileSync(sourcePath, 'sqlite\n')
    fsMockState.failSqliteRead = true

    const launchHomePath = materializeScopedCodexLaunchHome(sharedHomePath, launchRootPath, null)
    const targetPath = join(launchHomePath, 'logs_2.sqlite')
    const markerPath = join(launchHomePath, '.orca-launch-home-links', 'logs_2.sqlite.json')

    expect(existsSync(targetPath)).toBe(true)
    expect(
      fsMockState.readFilePaths.some(
        (readPath) => readPath === sourcePath || readPath === targetPath
      )
    ).toBe(false)
    expect(JSON.parse(readFileSync(markerPath, 'utf-8'))).toMatchObject({
      sourceDigest: null,
      targetDigest: null
    })
  })
})
