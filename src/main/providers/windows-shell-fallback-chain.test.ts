import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, win32 as pathWin32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildWindowsPowerShellSpawnAttempts,
  prependWindowsCodexShellHandoffAttempt
} from './windows-shell-fallback-chain'
import { decodeWindowsCodexShellHandoffConfig } from './windows-codex-shell-handoff'

const WIN_ENV: NodeJS.ProcessEnv = {
  ProgramW6432: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe'
}

const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => Object.defineProperty(process, 'platform', { configurable: true, value: original })
}

let restorePlatform: (() => void) | null = null
const tempRoots: string[] = []
afterEach(() => {
  restorePlatform?.()
  restorePlatform = null
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  return path
}

describe('buildWindowsPowerShellSpawnAttempts', () => {
  it('returns no attempts for non-PowerShell shells (cmd.exe keeps single-shell behavior)', () => {
    restorePlatform = setPlatform('win32')
    expect(
      buildWindowsPowerShellSpawnAttempts({
        shellPath: 'cmd.exe',
        cwd: 'C:\\repo',
        defaultCwd: 'C:\\Users\\dev'
      })
    ).toEqual([])
  })

  it('builds pwsh -> Windows PowerShell -> cmd.exe attempts with per-shell args', () => {
    restorePlatform = setPlatform('win32')
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (p) => p === PWSH7 || p === WINDOWS_POWERSHELL
      }
    })
    expect(attempts.map((a) => a.shellPath)).toEqual([PWSH7, WINDOWS_POWERSHELL, CMD])
    // PowerShell links use -EncodedCommand; cmd.exe uses /K chcp.
    expect(attempts[0].shellArgs).toContain('-EncodedCommand')
    expect(attempts[1].shellArgs).toContain('-EncodedCommand')
    expect(attempts[2].shellArgs[0]).toBe('/K')
  })

  it('repro: when pwsh is only a Store alias, the primary attempt is the real Windows PowerShell', () => {
    restorePlatform = setPlatform('win32')
    const aliasStub = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (p) => p === aliasStub || p === WINDOWS_POWERSHELL
      }
    })
    // The bare/alias pwsh.exe must never be the primary spawn target.
    expect(attempts[0].shellPath).toBe(WINDOWS_POWERSHELL)
    expect(attempts.map((a) => a.shellPath)).not.toContain(aliasStub)
    expect(attempts.map((a) => a.shellPath)).not.toContain('pwsh.exe')
    // Every attempt is an absolute path ConPTY can launch.
    for (const attempt of attempts) {
      expect(pathWin32.isAbsolute(attempt.shellPath)).toBe(true)
    }
  })

  it('prepends the Codex handoff while preserving the established shell fallbacks', () => {
    restorePlatform = setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'orca-windows-shell-fallback-'))
    tempRoots.push(root)
    const npmBin = join(root, 'npm-bin')
    const nodeBin = join(root, 'node-bin')
    const codexPath = makeFile(join(npmBin, 'codex.exe'))
    const nodePath = makeFile(join(nodeBin, 'node.exe'))
    const pathEnv = [npmBin, nodeBin].join(delimiter)
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: "codex 'fix it'",
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (path) => path === PWSH7 || path === WINDOWS_POWERSHELL
      }
    })

    const optimized = prependWindowsCodexShellHandoffAttempt({
      attempts,
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: "codex 'fix it'",
      launchAgent: 'codex',
      windowsCodexShellHandoff: true,
      env: { PATH: pathEnv, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    })

    expect(optimized).toHaveLength(attempts.length + 1)
    expect(optimized.slice(1)).toEqual(attempts)
    expect(optimized[0]).toMatchObject({
      shellPath: nodePath,
      logicalShellPath: PWSH7,
      startupCommandDeliveredInShellArgs: true
    })
    const config = decodeWindowsCodexShellHandoffConfig(optimized[0])
    expect(config.agentFile.toLowerCase()).toBe(codexPath.toLowerCase())
    expect(config.agentArgs).toEqual(['fix it'])
    expect(config.shellAttempts.map((attempt) => attempt.file)).toEqual([
      PWSH7,
      WINDOWS_POWERSHELL,
      CMD
    ])
    expect(config.agentFallbackAttempts.map((attempt) => attempt.file)).toEqual([
      PWSH7,
      WINDOWS_POWERSHELL
    ])
  })

  it('keeps metacharacters inside PowerShell-only async agent fallbacks', () => {
    restorePlatform = setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'orca-windows-shell-fallback-'))
    tempRoots.push(root)
    const npmBin = join(root, 'npm-bin')
    const nodeBin = join(root, 'node-bin')
    makeFile(join(npmBin, 'codex.exe'))
    makeFile(join(nodeBin, 'node.exe'))
    const command = "codex 'fix spaced & piped | redirected < input > output 100%'"
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: command,
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (path) => path === PWSH7 || path === WINDOWS_POWERSHELL
      }
    })

    const optimized = prependWindowsCodexShellHandoffAttempt({
      attempts,
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: command,
      launchAgent: 'codex',
      windowsCodexShellHandoff: true,
      env: {
        PATH: [npmBin, nodeBin].join(delimiter),
        PATHEXT: '.COM;.EXE;.BAT;.CMD'
      }
    })

    const config = decodeWindowsCodexShellHandoffConfig(optimized[0])
    expect(config.agentArgs).toEqual(['fix spaced & piped | redirected < input > output 100%'])
    expect(config.agentFallbackAttempts.map((attempt) => attempt.file)).toEqual([
      PWSH7,
      WINDOWS_POWERSHELL
    ])
    expect(config.agentFallbackAttempts.some((attempt) => attempt.file === CMD)).toBe(false)
    for (const fallback of config.agentFallbackAttempts) {
      const encodedCommand = fallback.args[fallback.args.indexOf('-EncodedCommand') + 1]
      expect(Buffer.from(encodedCommand ?? '', 'base64').toString('utf16le')).toContain(command)
    }
  })

  it('does not prepend the handoff without explicit default-command provenance', () => {
    restorePlatform = setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'orca-windows-shell-fallback-'))
    tempRoots.push(root)
    const npmBin = join(root, 'npm-bin')
    const nodeBin = join(root, 'node-bin')
    makeFile(join(npmBin, 'codex.exe'))
    makeFile(join(nodeBin, 'node.exe'))
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: "codex 'fix it'",
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (path) => path === PWSH7 || path === WINDOWS_POWERSHELL
      }
    })

    expect(
      prependWindowsCodexShellHandoffAttempt({
        attempts,
        cwd: 'C:\\repo',
        defaultCwd: 'C:\\Users\\dev',
        startupCommand: "codex 'fix it'",
        launchAgent: 'codex',
        env: {
          PATH: [npmBin, nodeBin].join(delimiter),
          PATHEXT: '.COM;.EXE;.BAT;.CMD'
        }
      })
    ).toEqual(attempts)
  })

  it('omits an unsafe cmd fallback for a 6,001-character native-spawn race', () => {
    restorePlatform = setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'orca-windows-shell-fallback-'))
    tempRoots.push(root)
    const npmBin = join(root, 'npm-bin')
    const nodeBin = join(root, 'node-bin')
    makeFile(join(npmBin, 'codex.exe'))
    makeFile(join(nodeBin, 'node.exe'))
    const pathEnv = [npmBin, nodeBin].join(delimiter)
    const command = `codex '${'x'.repeat(6_001)}'`
    const attempts = buildWindowsPowerShellSpawnAttempts({
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: command,
      resolveOptions: {
        platform: 'win32',
        env: WIN_ENV,
        isRealExecutable: (path) => path === PWSH7 || path === WINDOWS_POWERSHELL
      }
    })

    const optimized = prependWindowsCodexShellHandoffAttempt({
      attempts,
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\Users\\dev',
      startupCommand: command,
      launchAgent: 'codex',
      windowsCodexShellHandoff: true,
      env: { PATH: pathEnv, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    })

    expect(optimized).toHaveLength(attempts.length + 1)
    const config = decodeWindowsCodexShellHandoffConfig(optimized[0])
    expect(config.agentFallbackAttempts.map((attempt) => attempt.file)).toEqual([
      PWSH7,
      WINDOWS_POWERSHELL
    ])
    expect(config.shellAttempts.map((attempt) => attempt.file)).toEqual([
      PWSH7,
      WINDOWS_POWERSHELL,
      CMD
    ])
  })
})
