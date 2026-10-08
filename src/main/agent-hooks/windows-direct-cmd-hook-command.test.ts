// The registered command must not depend on the shell Claude selects.
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { WINDOWS_CMD_SAFE_PATH } from './installer-utils'
import { wrapWindowsDirectCmdHookCommand } from './windows-direct-cmd-hook-command'
import { getWindowsClaudeHookEntry } from '../claude/windows-hook-files'
import { getManagedScript } from '../claude/hook-script'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'
import { findGitBash } from './windows-git-bash-path.test-fixture'

const SAFE_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'

describe('wrapWindowsDirectCmdHookCommand', () => {
  it('emits an operator-free path that PowerShell 5.1 can parse', () => {
    expect(wrapWindowsDirectCmdHookCommand(SAFE_PATH)).toBe(
      'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd'
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
    expect(command).not.toMatch(/[|&;]/)
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

describe.skipIf(process.platform !== 'win32')(
  'direct hook command, run by Windows hook hosts',
  () => {
    // Git Bash is optional; cmd.exe and Windows PowerShell still exercise the command without it.
    const gitBash = ((): string | null => {
      try {
        return findGitBash()
      } catch {
        return null
      }
    })()

    async function runInHosts(command: string, cwd: string) {
      const hosts: [string, string[]][] = [
        ['cmd.exe', ['/d', '/c', command]],
        [getWindowsPowerShellExecutablePath(), ['-NoProfile', '-Command', command]]
      ]
      if (gitBash) {
        hosts.push([gitBash, ['-c', command]])
      }
      const pwsh = join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'PowerShell',
        '7',
        'pwsh.exe'
      )
      if (existsSync(pwsh)) {
        hosts.push([pwsh, ['-NoProfile', '-Command', command]])
      }
      const results: Awaited<ReturnType<typeof runCapture>>[] = []
      for (const [file, args] of hosts) {
        results.push(await runCapture(file, args, cwd))
      }
      return results
    }

    // Why async runProcess: runProcessSync cannot take a string stdin (it forces encoding 'buffer').
    async function runCapture(file: string, args: string[], cwd: string) {
      const result = await runProcess({
        program: file,
        args,
        cwd,
        // Why PATHEXT: without it Windows PowerShell 5.1 prints nothing and exits 0 for a .cmd path
        // (measured); every real hook host inherits it.
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          ComSpec: process.env.ComSpec,
          ORCA_BACKGROUND_LAUNCH: '1',
          HOME: cwd,
          // PowerShell starts batch files through cmd, whose AutoRun may read the host profile.
          USERPROFILE: process.env.USERPROFILE ?? cwd
        },
        input: '{"hook_event_name":"PreToolUse"}',
        timeoutMs: 5_000
      })
      expect(result.timedOut, result.stderr).toBe(false)
      return { stdout: result.stdout, status: result.code, label: `${file}: ${result.stderr}` }
    }

    // Why: a runner whose TEMP sits under a profile with a space is the encoded-launcher case,
    // so these legs skip rather than assert a contract that shape never claimed.
    const tempIsCmdSafe = WINDOWS_CMD_SAFE_PATH.test(join(tmpdir(), 'orca-direct-hook-x', 'x.cmd'))
    const canRunLive = tempIsCmdSafe

    async function withTempDir(
      run: (dir: string, scriptPath: string, command: string) => Promise<void>
    ): Promise<void> {
      const dir = mkdtempSync(join(tmpdir(), 'orca-direct-hook-'))
      try {
        const scriptPath = join(dir, 'claude-hook.cmd')
        const command = wrapWindowsDirectCmdHookCommand(scriptPath)
        expect(command, 'precondition: temp path must be cmd-safe').not.toBeNull()
        await run(dir, scriptPath, command!)
      } finally {
        // Why: cmd.exe/bash have just exited in this tree; a raw recursive rm throws EPERM on
        // Windows while their handles drain.
        removeTreeSync(dir)
      }
    }

    it.skipIf(!canRunLive)(
      'answers {} and exit 0 in both hosts when the script exists',
      async () => {
        await withTempDir(async (dir, scriptPath, command) => {
          writeFileSync(scriptPath, '@echo off\r\necho {}\r\nexit /b 0\r\n', 'utf8')
          for (const result of await runInHosts(command, dir)) {
            expect(result.stdout.trim(), result.label).toBe('{}')
            expect(result.status, result.label).toBe(0)
          }
        })
      }
    )

    it.skipIf(!canRunLive)(
      'runs the generated pair and answers when its payload is missing',
      async () => {
        await withTempDir(async (dir, scriptPath, command) => {
          writeFileSync(scriptPath, getWindowsClaudeHookEntry(), 'utf8')
          for (const result of await runInHosts(command, dir)) {
            expect(result.stdout.trim(), result.label).toBe('{}')
            expect(result.status, result.label).toBe(0)
          }
          writeFileSync(join(dir, 'claude-hook-impl.cmd'), getManagedScript(), 'utf8')
          for (const result of await runInHosts(command, dir)) {
            expect(result.stdout.trim(), result.label).toBe('{}')
            expect(result.status, result.label).toBe(0)
          }
        })
      }
    )

    it.skipIf(!canRunLive)(
      'reports a non-blocking failure, never exit 2, when the entry is gone',
      async () => {
        await withTempDir(async (dir, scriptPath, command) => {
          expect(existsSync(scriptPath)).toBe(false)
          for (const result of await runInHosts(command, dir)) {
            expect(result.stdout.trim(), result.label).toBe('')
            expect(result.status, result.label).toBeGreaterThan(0)
            expect(result.status, result.label).not.toBe(2)
          }
        })
      }
    )

    it.skipIf(!canRunLive)(
      'leaves no stray `nul` file behind in the working directory',
      async () => {
        // Why this is worth a test: adding `2>nul` to silence the missing-script line looks like
        // tidy-up, but under MSYS it creates a real file named `nul` in the cwd — which is the
        // user's repo. Measured on Windows 11. Keep stderr unredirected.
        await withTempDir(async (dir, _scriptPath, command) => {
          await runInHosts(command, dir)
          expect(readdirSync(dir)).not.toContain('nul')
        })
      }
    )
  }
)
