import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchOrcaApp } from './launch'

const TOUCHED_ENV = [
  'ORCA_OPEN_COMMAND',
  'ORCA_APP_EXECUTABLE',
  'ORCA_USER_DATA_PATH',
  'ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT'
] as const

describe.skipIf(process.platform !== 'win32')('launchOrcaApp executable override', () => {
  const savedEnv = new Map<string, string | undefined>()
  let tempDir: string | undefined

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    savedEnv.clear()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      tempDir = undefined
    }
  })

  it('keeps a spaced profile path as one argument for a .cmd executable', async () => {
    for (const key of TOUCHED_ENV) {
      savedEnv.set(key, process.env[key])
    }
    tempDir = mkdtempSync(join(tmpdir(), 'orca-launch-'))
    const outputPath = join(tempDir, 'args.txt')
    const shimPath = join(tempDir, 'orca-shim.cmd')
    // Per-argument echo: %* would replay the raw command tail and hide token splitting.
    writeFileSync(
      shimPath,
      [
        '@echo off',
        ':next',
        'if "%~1"=="" goto done',
        `>> "${outputPath}" echo [%~1]`,
        'shift',
        'goto next',
        ':done'
      ].join('\r\n')
    )
    const userDataPath = join(tempDir, 'John Doe', 'orca')
    mkdirSync(userDataPath, { recursive: true })
    delete process.env.ORCA_OPEN_COMMAND
    delete process.env.ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT
    process.env.ORCA_APP_EXECUTABLE = shimPath
    process.env.ORCA_USER_DATA_PATH = userDataPath

    launchOrcaApp()

    for (const token of [`[--user-data-dir=${userDataPath}]`, '[--orca-background-open]']) {
      await vi.waitFor(() => expect(echoedArgs(outputPath)).toContain(token), {
        timeout: 5_000,
        interval: 50
      })
    }
  })
})

function echoedArgs(outputPath: string): string[] {
  return existsSync(outputPath)
    ? readFileSync(outputPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
    : []
}
