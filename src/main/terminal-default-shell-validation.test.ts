import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getLaunchablePosixShellOverrideForSpawn,
  requireValidPosixShellOverrideForSpawn,
  validateTerminalDefaultShellPath
} from './terminal-default-shell-validation'

const itOnPosix = process.platform === 'win32' ? it.skip : it

describe('validateTerminalDefaultShellPath', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-shell-validation-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  itOnPosix('accepts executable recognized shell binaries', () => {
    const shellPath = join(dir, 'fish')
    writeFileSync(shellPath, '#!/bin/sh\n')
    chmodSync(shellPath, 0o755)

    expect(validateTerminalDefaultShellPath(shellPath)).toEqual({
      ok: true,
      shellPath
    })
  })

  itOnPosix('rejects missing, non-executable, and non-shell paths', () => {
    const notExecutable = join(dir, 'bash')
    const notShell = join(dir, 'node')
    const directory = join(dir, 'zsh')
    writeFileSync(notExecutable, '#!/bin/sh\n')
    chmodSync(notExecutable, 0o644)
    writeFileSync(notShell, '#!/bin/sh\n')
    chmodSync(notShell, 0o755)
    mkdirSync(directory)

    expect(validateTerminalDefaultShellPath(join(dir, 'missing')).ok).toBe(false)
    expect(validateTerminalDefaultShellPath(notExecutable)).toMatchObject({
      ok: false,
      code: 'not-executable'
    })
    expect(validateTerminalDefaultShellPath(notShell)).toMatchObject({
      ok: false,
      code: 'not-recognized-shell'
    })
    expect(validateTerminalDefaultShellPath(directory)).toMatchObject({
      ok: false,
      code: 'not-file'
    })
  })

  itOnPosix('ignores stale non-POSIX spawn overrides but validates absolute ones', () => {
    const shellPath = join(dir, 'fish')
    writeFileSync(shellPath, '#!/bin/sh\n')
    chmodSync(shellPath, 0o755)

    expect(requireValidPosixShellOverrideForSpawn('powershell.exe')).toBeUndefined()
    expect(requireValidPosixShellOverrideForSpawn(shellPath)).toBe(shellPath)
    expect(() => requireValidPosixShellOverrideForSpawn(join(dir, 'missing'))).toThrow(
      'does not exist'
    )
    expect(getLaunchablePosixShellOverrideForSpawn('powershell.exe')).toBeUndefined()
    expect(getLaunchablePosixShellOverrideForSpawn(shellPath)).toBe(shellPath)
    expect(getLaunchablePosixShellOverrideForSpawn(join(dir, 'missing'))).toBeUndefined()
  })
})
