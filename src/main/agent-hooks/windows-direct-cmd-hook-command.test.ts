// Why (#18875): the registered Windows Claude hook is now the script path itself, so this file
// pins the two things that make that safe — the shape carries nothing MSYS or cmd.exe rewrites,
// and it still answers with neutral JSON when the script is gone. The live legs run the string
// through BOTH hosts Claude Code can pick, because the shape has to parse in either.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'
import { wrapWindowsDirectCmdHookCommand } from './windows-direct-cmd-hook-command'
import { findGitBash } from './windows-git-bash-path.test-fixture'

const SAFE_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'

describe('wrapWindowsDirectCmdHookCommand', () => {
  it('emits the script path with forward slashes and a neutral-JSON fallback', () => {
    expect(wrapWindowsDirectCmdHookCommand(SAFE_PATH)).toBe(
      'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd || echo {}'
    )
  })

  it('spells nothing either shell would rewrite or reinterpret', () => {
    const command = wrapWindowsDirectCmdHookCommand(SAFE_PATH)!

    // Why: MSYS rewrites `/c`-shaped tokens into drive paths — a literal `cmd.exe /d /c <path>`
    // does not survive Git Bash (measured), which is why no interpreter is spelled at all.
    expect(command).not.toMatch(/ \/[a-zA-Z]+( |$)/)
    expect(command).not.toMatch(/\\/)
    expect(command).not.toMatch(/["']/)
    expect(command).not.toMatch(/powershell|cmd\.exe|conhost/i)
    // Why: `2>nul` writes a literal file named `nul` into the cwd under MSYS (measured), and no
    // stderr sink parses in both hosts. The missing-script line is left on stderr deliberately.
    expect(command).not.toContain('2>')
  })

  it('declines any path the shells cannot carry bare', () => {
    for (const path of [
      'C:\\Users\\Bob Smith\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\%name%\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a^b\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a&b\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a(b)\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\rené\\.orca\\agent-hooks\\claude-hook.cmd',
      '/home/alice/.orca/agent-hooks/claude-hook.sh',
      // Why: WINDOWS_CMD_SAFE_PATH admits a UNC profile, but `//server/share/...` is not a
      // command cmd.exe reliably starts — keep those on the encoded launcher.
      '\\\\server\\share\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
    ]) {
      expect(wrapWindowsDirectCmdHookCommand(path), path).toBeNull()
    }
  })
})

describe.skipIf(process.platform !== 'win32')('direct hook command, run by both hook hosts', () => {
  // Why: the fixture throws when Git Bash is absent, and that is a skip here, not a failure —
  // a box without it never gets this command shape in the first place.
  const gitBash = ((): string | null => {
    try {
      return findGitBash()
    } catch {
      return null
    }
  })()

  function runInCmd(command: string, cwd: string): { stdout: string; status: number } {
    return runCapture('cmd.exe', ['/d', '/c', command], cwd)
  }

  function runInBash(command: string, cwd: string): { stdout: string; status: number } {
    return runCapture(gitBash!, ['-c', command], cwd)
  }

  function runCapture(file: string, args: string[], cwd: string) {
    try {
      const stdout = execFileSync(file, args, {
        cwd,
        input: '{"hook_event_name":"PreToolUse"}',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      return { stdout, status: 0 }
    } catch (error) {
      const failure = error as { stdout?: string; status?: number }
      return { stdout: failure.stdout ?? '', status: failure.status ?? 1 }
    }
  }

  // Why: a runner whose TEMP sits under a profile with a space is the encoded-launcher case,
  // so these legs skip rather than assert a contract that shape never claimed.
  const tempIsCmdSafe = WINDOWS_CMD_SAFE_PATH.test(join(tmpdir(), 'orca-direct-hook-x', 'x.cmd'))
  const canRunLive = Boolean(gitBash) && tempIsCmdSafe

  function withTempDir(run: (dir: string, scriptPath: string, command: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'orca-direct-hook-'))
    try {
      const scriptPath = join(dir, 'claude-hook.cmd')
      const command = wrapWindowsDirectCmdHookCommand(scriptPath)
      expect(command, 'precondition: temp path must be cmd-safe').not.toBeNull()
      run(dir, scriptPath, command!)
    } finally {
      // Why: cmd.exe/bash have just exited in this tree; a raw recursive rm throws EPERM on
      // Windows while their handles drain.
      removeTreeSync(dir)
    }
  }

  it.skipIf(!canRunLive)('answers {} and exit 0 in both hosts when the script exists', () => {
    withTempDir((dir, scriptPath, command) => {
      writeFileSync(scriptPath, '@echo off\r\necho {}\r\nexit /b 0\r\n', 'utf8')
      for (const result of [runInCmd(command, dir), runInBash(command, dir)]) {
        expect(result.stdout.trim()).toBe('{}')
        expect(result.status).toBe(0)
      }
    })
  })

  it.skipIf(!canRunLive)(
    'still answers {} and exit 0 in both hosts when the script is gone',
    () => {
      // Why: compat consumers require neutral JSON even with no managed script (#14818). The
      // encoded launcher did this with a Test-Path; `|| echo {}` does it with no interpreter.
      withTempDir((dir, scriptPath, command) => {
        expect(existsSync(scriptPath)).toBe(false)
        for (const result of [runInCmd(command, dir), runInBash(command, dir)]) {
          expect(result.stdout.trim()).toBe('{}')
          expect(result.status).toBe(0)
        }
      })
    }
  )

  it.skipIf(!canRunLive)('leaves no stray `nul` file behind in the working directory', () => {
    // Why this is worth a test: adding `2>nul` to silence the missing-script line looks like
    // tidy-up, but under MSYS it creates a real file named `nul` in the cwd — which is the
    // user's repo. Measured on Windows 11. Keep stderr unredirected.
    withTempDir((dir, _scriptPath, command) => {
      runInBash(command, dir)
      expect(readdirSync(dir)).not.toContain('nul')
    })
  })
})
