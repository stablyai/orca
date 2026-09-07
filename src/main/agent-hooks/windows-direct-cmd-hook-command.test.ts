// Why (#18875): the registered Windows Claude hook is now the script path itself, so this file
// pins the two things that make that safe — the shape carries nothing MSYS or cmd.exe rewrites,
// and it still answers with neutral JSON when the script is gone. The live legs run the string
// through BOTH hosts Claude Code can pick, because the shape has to parse in either.
//
// Why (#19187): two defects in those live legs let a spaced profile through. (a) `canRunLive`
// gated on the temp path being cmd-safe, so on `C:\Users\First Last` the legs skipped entirely
// and nothing exercised a spaced path through a real host. (b) They asserted only that stdout
// was `{}` — which is exactly what `|| echo {}` prints when dispatch FAILS, so a hook that never
// ran passed. Both are fixed below: a dedicated spaced-path directory, and a marker the fallback
// cannot fake.
import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { wrapWindowsDirectCmdHookCommand } from './windows-direct-cmd-hook-command'
import { findGitBash } from './windows-git-bash-path.test-fixture'

const SAFE_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
const SPACED_PATH = 'C:\\Users\\Bob Smith\\.orca\\agent-hooks\\claude-hook.cmd'

describe('wrapWindowsDirectCmdHookCommand', () => {
  it('emits the script path with forward slashes and a neutral-JSON fallback', () => {
    expect(wrapWindowsDirectCmdHookCommand(SAFE_PATH)).toBe(
      '"C:/Users/alice/.orca/agent-hooks/claude-hook.cmd" || echo {}'
    )
  })

  // Why (#19187): a spaced profile is the case #18875 could not serve. It is quoted, not declined.
  it('carries a spaced path instead of declining it', () => {
    expect(wrapWindowsDirectCmdHookCommand(SPACED_PATH)).toBe(
      '"C:/Users/Bob Smith/.orca/agent-hooks/claude-hook.cmd" || echo {}'
    )
  })

  it('spells nothing either shell would rewrite or reinterpret', () => {
    for (const command of [
      wrapWindowsDirectCmdHookCommand(SAFE_PATH)!,
      wrapWindowsDirectCmdHookCommand(SPACED_PATH)!
    ]) {
      // Why: MSYS rewrites `/c`-shaped tokens into drive paths — a literal `cmd.exe /d /c <path>`
      // does not survive Git Bash (measured), which is why no interpreter is spelled at all.
      expect(command).not.toMatch(/ \/[a-zA-Z]+( |$)/)
      expect(command).not.toMatch(/\\/)
      expect(command).not.toMatch(/powershell|cmd\.exe|conhost/i)
      // Why (#19187): this used to forbid quoting outright. Double quotes around the whole path
      // are the one form both hosts agree on, so what is actually hazardous is narrower — a
      // single quote (cmd treats `'` as a literal filename character), a backslash-escaped space
      // (bash-only), and a caret (cmd-only). Forbid those, and require the command to open with
      // exactly one token that is either fully double-quoted or bare.
      expect(command).not.toMatch(/'/)
      expect(command).not.toMatch(/\\ |\^/)
      expect(command).toMatch(/^(?:"[^"]+"|[^\s"]+) \|\| echo \{\}$/)
      // Why: `2>nul` writes a literal file named `nul` into the cwd under MSYS (measured), and no
      // stderr sink parses in both hosts. The missing-script line is left on stderr deliberately.
      expect(command).not.toContain('2>')
    }
  })

  it('declines any path the shells cannot carry', () => {
    for (const path of [
      // Why (#19187): quoting cannot save these. cmd expands `%VAR%` inside double quotes, and
      // `!VAR!` too under delayed expansion, so they must stay on the encoded launcher.
      'C:\\Users\\%name%\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a!b\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a^b\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a&b\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a(b)\\.orca\\agent-hooks\\claude-hook.cmd',
      'C:\\Users\\a"b\\.orca\\agent-hooks\\claude-hook.cmd',
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

  // Why (#19187): the previous cmd leg was `execFileSync('cmd.exe', ['/d','/c', command])`.
  // libuv applies MSVCRT quoting to that argument, turning the command's own `"` into `\"`;
  // cmd.exe does not decode backslash escapes, so with four quotes on the line its `/C` rule
  // falls to "old behaviour" (strip the leading quote and the last quote) and the command token
  // ends up starting with a backslash. Dispatch then fails and `|| echo {}` reports exit 0 — a
  // false FAIL for any quoted command. No real consumer invokes cmd that way: Node's own
  // `shell: true` emits `cmd.exe /d /s /c "<command>"` with a verbatim command line, which is
  // what this uses. `/s` makes the outer-quote strip unconditional; `/c` alone only tolerates a
  // single quoted token and breaks the moment a second one appears.
  function runInCmd(command: string, cwd: string): { stdout: string; status: number } {
    const result = spawnSync(process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
      cwd,
      input: '{"hook_event_name":"PreToolUse"}',
      encoding: 'utf8',
      windowsVerbatimArguments: true
    })
    return { stdout: result.stdout ?? '', status: result.status ?? 1 }
  }

  function runInBash(command: string, cwd: string): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(gitBash!, ['-c', command], {
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

  // Why (#19187): this used to require the temp path to be cmd-safe, which skipped every
  // spaced-profile runner — the exact configuration that was broken, so a space must no longer
  // disqualify. A TEMP carrying something outside the quotable class (`%`, a caret, non-ASCII)
  // genuinely is the encoded-launcher case and this shape never claimed to serve it, so that
  // still skips — but per prefix, and visibly, rather than by asserting inside the body.
  const canRunLive = Boolean(gitBash)

  function prefixIsSupported(prefix: string): boolean {
    return (
      wrapWindowsDirectCmdHookCommand(join(tmpdir(), `${prefix}probe`, 'claude-hook.cmd')) !== null
    )
  }

  function withTempDir(
    prefix: string,
    run: (dir: string, scriptPath: string, command: string) => void
  ): void {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    try {
      const scriptPath = join(dir, 'claude-hook.cmd')
      const command = wrapWindowsDirectCmdHookCommand(scriptPath)
      expect(command, `precondition: ${scriptPath} must be supported`).not.toBeNull()
      run(dir, scriptPath, command!)
    } finally {
      // Why: cmd.exe/bash have just exited in this tree; a raw recursive rm throws EPERM on
      // Windows while their handles drain.
      removeTreeSync(dir)
    }
  }

  // Why (#19187): `ORCA_RAN`, not `{}`. Asserting `{}` cannot tell "the script ran and printed
  // neutral JSON" from "dispatch failed and the fallback fired" — which is how a spaced path
  // passed this suite while the hook never executed.
  const MARKER_SCRIPT = '@echo off\r\necho ORCA_RAN\r\nexit /b 0\r\n'

  for (const [label, prefix] of [
    ['a cmd-safe path', 'orca-direct-hook-'],
    ['a path with a space', 'orca direct hook ']
  ] as const) {
    const skipPrefix = !canRunLive || !prefixIsSupported(prefix)

    it.skipIf(skipPrefix)(`runs the script in both hosts, on ${label}`, () => {
      withTempDir(prefix, (dir, scriptPath, command) => {
        writeFileSync(scriptPath, MARKER_SCRIPT, 'utf8')
        for (const result of [runInCmd(command, dir), runInBash(command, dir)]) {
          expect(result.stdout.trim()).toBe('ORCA_RAN')
          expect(result.status).toBe(0)
        }
      })
    })

    it.skipIf(skipPrefix)(`answers {} in both hosts when the script is gone, on ${label}`, () => {
      // Why: compat consumers require neutral JSON even with no managed script (#14818). The
      // encoded launcher did this with a Test-Path; `|| echo {}` does it with no interpreter.
      withTempDir(prefix, (dir, scriptPath, command) => {
        expect(existsSync(scriptPath)).toBe(false)
        for (const result of [runInCmd(command, dir), runInBash(command, dir)]) {
          expect(result.stdout.trim()).toBe('{}')
          expect(result.status).toBe(0)
        }
      })
    })
  }

  it.skipIf(!canRunLive || !prefixIsSupported('orca direct hook '))(
    'leaves no stray `nul` file behind in the working directory',
    () => {
      // Why this is worth a test: adding `2>nul` to silence the missing-script line looks like
      // tidy-up, but under MSYS it creates a real file named `nul` in the cwd — which is the
      // user's repo. Measured on Windows 11. Keep stderr unredirected.
      withTempDir('orca direct hook ', (dir, _scriptPath, command) => {
        runInBash(command, dir)
        expect(readdirSync(dir)).not.toContain('nul')
      })
    }
  )
})
