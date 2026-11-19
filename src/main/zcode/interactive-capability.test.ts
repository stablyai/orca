import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetZCodeInteractiveCapabilityForTests,
  readZCodeInteractiveCapability,
  resolveZCodeCommandOverride,
  resolveZCodeExecutable
} from './interactive-capability'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-zcode-capability-'))
  _resetZCodeInteractiveCapabilityForTests()
})

afterEach(() => {
  _resetZCodeInteractiveCapabilityForTests()
  rmSync(root, { recursive: true, force: true })
})

describe('resolveZCodeCommandOverride', () => {
  it('defaults to zcode when unset, blank, or invalid', () => {
    expect(resolveZCodeCommandOverride(undefined, 'darwin')).toBe('zcode')
    expect(resolveZCodeCommandOverride('   ', 'win32')).toBe('zcode')
    expect(resolveZCodeCommandOverride('zcode\0bad', 'linux')).toBe('zcode')
  })

  it('extracts executable tokens from overrides with flags, quotes, and Windows PowerShell &', () => {
    expect(resolveZCodeCommandOverride('zcode --mode yolo', 'linux')).toBe('zcode')
    expect(resolveZCodeCommandOverride('"/opt/My ZCode/zcode" --mode yolo', 'darwin')).toBe(
      '/opt/My ZCode/zcode'
    )
    expect(
      resolveZCodeCommandOverride('& "C:\\Program Files\\ZCode\\zcode.cmd" --mode yolo', 'win32')
    ).toBe('C:\\Program Files\\ZCode\\zcode.cmd')
  })
})

describe('readZCodeInteractiveCapability', () => {
  it.skipIf(process.platform !== 'win32')(
    'resolves and probes Windows .cmd shims on PATH, in npm fallback dir, and via extensionless override with per-command caching',
    async () => {
      const home = join(root, 'home')
      const pathDir = join(root, 'path-bin')
      const npmDir = join(home, 'AppData', 'Roaming', 'npm')
      const overrideDir = join(root, 'override-bin')
      mkdirSync(pathDir, { recursive: true })
      mkdirSync(npmDir, { recursive: true })
      mkdirSync(overrideDir, { recursive: true })

      const countFile = join(root, 'invocations.txt')
      // Windows npm global installs write an extensionless POSIX shim alongside `.cmd`.
      writeFileSync(join(pathDir, 'zcode'), '#!/bin/sh\necho posix shim\n')
      writeFileSync(
        join(pathDir, 'zcode.cmd'),
        [
          '@echo off',
          `echo hit>>"${countFile}"`,
          "echo Cannot find package '@zcode/tui' 1>&2",
          'exit /b 1',
          ''
        ].join('\r\n')
      )

      const pathEnv = { ...process.env, PATH: pathDir, Path: pathDir }
      expect(await readZCodeInteractiveCapability('zcode', { env: pathEnv, homePath: home })).toBe(
        'missing-tui'
      )
      // Second call for the same resolved binary hits the cache instead of re-spawning.
      expect(await readZCodeInteractiveCapability('zcode', { env: pathEnv, homePath: home })).toBe(
        'missing-tui'
      )
      expect(readFileSync(countFile, 'utf-8').trim().split(/\r?\n/)).toHaveLength(1)

      // Absent from PATH, falls back to %USERPROFILE%\AppData\Roaming\npm\zcode.cmd.
      writeFileSync(join(npmDir, 'zcode'), '#!/bin/sh\necho posix shim\n')
      writeFileSync(
        join(npmDir, 'zcode.cmd'),
        ['@echo off', "echo Cannot find module '@zcode/tui' 1>&2", 'exit /b 1', ''].join('\r\n')
      )
      const emptyPathEnv = { ...process.env, PATH: '', Path: '' }
      expect(await resolveZCodeExecutable('zcode', { env: emptyPathEnv, homePath: home })).toBe(
        join(npmDir, 'zcode.cmd')
      )
      expect(
        await readZCodeInteractiveCapability('zcode', { env: emptyPathEnv, homePath: home })
      ).toBe('missing-tui')

      // Explicit extensionless Windows override resolves to `.cmd` and uses its own cache slot.
      writeFileSync(join(overrideDir, 'zcode'), '#!/bin/sh\necho posix shim\n')
      writeFileSync(
        join(overrideDir, 'zcode.cmd'),
        ['@echo off', 'echo Raw mode is not supported 1>&2', 'exit /b 1', ''].join('\r\n')
      )
      const overridePath = join(overrideDir, 'zcode')
      expect(
        await resolveZCodeExecutable(overridePath, { env: emptyPathEnv, homePath: home })
      ).toBe(join(overrideDir, 'zcode.cmd'))
      expect(
        await readZCodeInteractiveCapability(overridePath, { env: emptyPathEnv, homePath: home })
      ).toBe('interactive')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'resolves fallback install dirs and tilde overrides on POSIX with per-command caching',
    async () => {
      const home = join(root, 'home')
      const localBin = join(home, '.local', 'bin')
      const customBin = join(home, 'custom-bin')
      mkdirSync(localBin, { recursive: true })
      mkdirSync(customBin, { recursive: true })

      const countFile = join(root, 'invocations.txt')
      const fallbackZcode = join(localBin, 'zcode')
      writeFileSync(
        fallbackZcode,
        `#!/bin/sh\necho hit >> "${countFile}"\necho "Cannot find package '@zcode/tui'" >&2\nexit 1\n`
      )
      chmodSync(fallbackZcode, 0o755)

      const emptyPathEnv = { ...process.env, PATH: '' }
      expect(await resolveZCodeExecutable('zcode', { env: emptyPathEnv, homePath: home })).toBe(
        fallbackZcode
      )
      expect(
        await readZCodeInteractiveCapability('zcode', { env: emptyPathEnv, homePath: home })
      ).toBe('missing-tui')
      expect(
        await readZCodeInteractiveCapability('zcode', { env: emptyPathEnv, homePath: home })
      ).toBe('missing-tui')
      expect(readFileSync(countFile, 'utf-8').trim().split('\n')).toHaveLength(1)

      const customZcode = join(customBin, 'zcode')
      writeFileSync(customZcode, '#!/bin/sh\necho "TTY required" >&2\nexit 1\n')
      chmodSync(customZcode, 0o755)
      expect(
        await readZCodeInteractiveCapability('~/custom-bin/zcode', {
          env: emptyPathEnv,
          homePath: home
        })
      ).toBe('interactive')
    }
  )

  it('does not cache unknown verdicts when the target binary is missing and retries once it exists', async () => {
    const missing = join(root, process.platform === 'win32' ? 'late-zcode.cmd' : 'late-zcode')
    expect(await readZCodeInteractiveCapability(missing)).toBe('unknown')

    if (process.platform === 'win32') {
      writeFileSync(
        missing,
        ['@echo off', "echo Cannot find package '@zcode/tui' 1>&2", 'exit /b 1', ''].join('\r\n')
      )
    } else {
      writeFileSync(missing, '#!/bin/sh\necho "Cannot find package \'@zcode/tui\'" >&2\nexit 1\n')
      chmodSync(missing, 0o755)
    }
    expect(await readZCodeInteractiveCapability(missing)).toBe('missing-tui')
  })
})
