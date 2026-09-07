import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePosixTombstoneInterpreter } from './legacy-terminal-posix-tombstone'
import {
  __resetLegacyTerminalShimNeutralizationForTests,
  neutralizeLegacyTerminalShimDir
} from './legacy-terminal-shim-dir'

// Why: `expect(text.indexOf(a)).toBeLessThan(text.indexOf(b))` passes when `a` is absent, because
// indexOf returns -1. Every ordering pin must assert both operands exist first.
function expectOrdered(text: string, first: string, second: string): void {
  expect(text, `missing: ${first}`).toContain(first)
  expect(text, `missing: ${second}`).toContain(second)
  expect(text.indexOf(first)).toBeLessThan(text.indexOf(second))
}

describe('legacy terminal Windows tombstone text', () => {
  const tempRoots: string[] = []

  const makeUserDataDir = (): string => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-legacy-shim-win-'))
    tempRoots.push(userData)
    return userData
  }

  beforeEach(() => {
    __resetLegacyTerminalShimNeutralizationForTests()
  })

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects stale Windows real-command paths inside the wrapper directory', () => {
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    const cmd = readFileSync(join(win32Dir, 'git.cmd'), 'utf8')
    expect(cmd).toContain(
      'if defined orca_real for %%G in ("%orca_real%") do if /I "%%~dpG"=="%~dp0" set "orca_real="'
    )
    // Why: a captured path that no longer exists must be cleared, or the where.exe fallback below
    // is skipped and the wrapper execs a missing binary.
    expect(cmd).toContain('if defined orca_real if not exist "%orca_real%" set "orca_real="')
    expectOrdered(cmd, 'if not exist "%orca_real%"', ':orca_try_candidate')
    const powershell = readFileSync(join(win32Dir, 'git-wrapper.ps1'), 'utf8')
    expect(powershell).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(powershell).toContain('$realCommand = $null')
    expectOrdered(
      powershell,
      '[StringComparison]::OrdinalIgnoreCase',
      'Test-Path -LiteralPath $realCommand'
    )
  })

  it('emits no percent expression inside a cmd rem comment', () => {
    // Why: cmd expands variables inside rem, so a comment mentioning the working directory
    // substitutes it into the comment text. Harmless at top level -- verified on Windows 11 that
    // rem does not re-parse the result, so a cwd of `C:\\x&pwned&rem` executed nothing -- but rem
    // treats separators differently inside a parenthesized block, and this script now has some.
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    for (const command of ['git', 'gh'] as const) {
      const offending = readFileSync(join(win32Dir, `${command}.cmd`), 'utf8')
        .split('\r\n')
        .filter((line) => /^\s*rem\b/i.test(line) && line.includes('%'))
      expect(offending, `rem comments with percent expressions: ${offending.join(' | ')}`).toEqual(
        []
      )
    }
  })

  it('keeps the Windows wrappers ASCII-only', () => {
    // Why: cmd.exe seeks through a batch file in bytes but advances by decoded character count,
    // so a single multi-byte character shifts every following line. Two em dashes in comments
    // made it drop the first four characters of every line and the wrapper died with "The
    // syntax of the command is incorrect." Proven on Windows 11; no test caught it.
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    for (const name of ['git.cmd', 'gh.cmd', 'git-wrapper.ps1', 'gh-wrapper.ps1']) {
      const contents = readFileSync(join(win32Dir, name), 'utf8')
      const offending = [...contents].find((character) => character.charCodeAt(0) > 0x7f)
      expect(offending, `${name} contains non-ASCII ${JSON.stringify(offending)}`).toBeUndefined()
      expect(Buffer.byteLength(contents, 'utf8')).toBe(contents.length)
    }
  })

  it('resolves Windows fallbacks against PATH only, never the current directory', () => {
    // Why (STA-4169): bare `where.exe git.exe` searches cwd before PATH, so a repository-local
    // git.exe/gh.exe could be executed with the user's arguments.
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    for (const command of ['git', 'gh'] as const) {
      const cmd = readFileSync(join(win32Dir, `${command}.cmd`), 'utf8')
      // No where.exe at all: it searches cwd first, so the wrapper walks the cleaned PATH.
      expect(cmd).not.toContain('where.exe')
      expect(cmd).toContain('for %%P in ("%orca_clean_path:;=" "%") do (')
      expect(cmd).toContain(`if exist "%orca_candidate_dir%\\${command}.exe"`)
      // Why: %~f preserves a trailing separator; without normalizing, a wrapper-dir entry
      // spelled with one escapes self-exclusion and the wrapper tail-loops on itself. The
      // separator lives in a variable because a literal backslash before the closing quote
      // breaks cmd's parser, and a sentinel character would corrupt paths containing it.
      expect(cmd).toContain('set "orca_sep=\\"')
      // Why: bare setlocal inherits the caller's delayed-expansion state. Under a parent shell
      // with /V:ON, a literal !CD! PATH entry became the cwd and ran a planted git.cmd (exit 66),
      // and a legitimate directory containing ! stopped resolving (exit 127). Both on Windows 11.
      expect(cmd).toContain('setlocal DisableDelayedExpansion')
      expect(cmd).not.toContain('\r\nsetlocal\r\n')
      // Why: a captured ORCA_REAL_* may be relative, and both the existence test and the
      // invocation resolve it against the cwd.
      expect(cmd).toContain('if defined orca_real call :orca_check_rooted')
      expect(cmd).toContain('if defined orca_real if not defined orca_rooted set "orca_real="')
      // Why: the exported PATH is inherited by the real command; a relative entry left in it lets
      // the cwd select the tools that command spawns.
      // Why the exact block, not an ordering pin: the first ':orca_append_path' in the file is
      // the top-level CALL, and the first 'if not defined orca_rooted' belongs to a different
      // subroutine, so an ordering pin stayed green with this subroutine's guard deleted.
      expect(cmd).toContain(':orca_append_path\r\nif not defined orca_entry exit /b\r\n')
      expect(cmd).toContain(
        'set "orca_probe=%orca_entry%"\r\ncall :orca_check_rooted\r\nif not defined orca_rooted exit /b\r\nfor %%G in ("%orca_entry%") do set "orca_path_entry_dir=%%~fG"'
      )
      // Why: CALL re-expands its own command line, so path data passed as an argument gets a
      // second round of percent expansion. A PATH entry holding a literal %CD% became the
      // current directory before the rooted check saw it and the planted git.cmd ran (rc=66 on
      // Windows 11). Every caller must hand the value over in a variable instead.
      expect(cmd).not.toContain('call :orca_check_rooted "')
      expect(cmd).not.toContain('call :orca_try_candidate "')
      expect(cmd).not.toContain('call :orca_append_path "')
      expect(cmd).not.toContain('%~1')
      expect(cmd).toContain('set "orca_probe=%orca_entry%"\r\ncall :orca_check_rooted\r\n')
      // Why: orca_sep is compared against before the legacy dir is normalized; defining it later
      // made that strip silently no-op and left the legacy dir on PATH.
      expectOrdered(cmd, 'set "orca_sep=', 'if "%orca_legacy_norm:~-1%."')
      // Why: %orca_sep% expands before the line is parsed, so `=="%orca_sep%"` becomes `=="\"` —
      // the literal trap the variable exists to avoid. Both sides must carry the trailing dot.
      expect(cmd).not.toContain('=="%orca_sep%"')
      // Why: nothing else asserts the *reject* path, so deleting it would reopen the cwd hijack
      // while every accept-path assertion stayed green.
      expectOrdered(
        cmd,
        'call :orca_check_rooted\r\nif not defined orca_rooted exit /b',
        'for %%G in ("%orca_entry%") do set "orca_candidate_dir='
      )
      expect(cmd).toContain('if not defined orca_rooted exit /b')
      expect(cmd).toContain('if "%orca_candidate_dir:~-1%."=="%orca_sep%."')
      expect(cmd).not.toContain(':\\#=#%')
      // A candidate inside the wrapper directory must still be rejected, compared against the
      // cached wrapper dir because %~dp0 is rebound inside a CALL.
      expect(cmd).toContain('if /I "%orca_candidate_dir%\\"=="%orca_wrapper_dir%" exit /b')
      // Relative entries resolve against the cwd, so they must be rejected like empty ones.
      // Why: the rooted-path test must not shell out — an external tool would itself be
      // resolved from the cwd, reintroducing the hijack.
      expect(cmd).not.toContain('findstr')
      expect(cmd).toContain('if "%orca_probe:~1,2%"==":\\" set "orca_rooted=1"')
      expect(cmd).toContain('if "%orca_probe:~0,2%"=="\\\\" set "orca_rooted=1"')
      // Why: these two guards are the only thing stopping an empty element reaching the cwd on
      // Windows; deleting either left every other assertion green.
      expect(cmd).toContain('if not defined orca_entry exit /b')

      const powershell = readFileSync(join(win32Dir, `${command}-wrapper.ps1`), 'utf8')
      expect(powershell).not.toContain('Get-Command')
      expect(powershell).toContain("($env:PATH -split ';')")
      // Why: the rooted check must reject drive-relative 'C:foo', which still resolves against
      // the cwd — so the IsPathRooted call must be gone, replaced by an explicit prefix match.
      expect(powershell).not.toContain('[IO.Path]::IsPathRooted(')
      expect(powershell).toContain("$pathEntry -match '^([A-Za-z]:[\\\\/]|\\\\\\\\)'")
      expect(powershell).toContain("$realCommand -notmatch '^([A-Za-z]:[\\\\/]|\\\\\\\\)'")
      // Why the full pattern, not a prefix: `^([A-Za-z]:|\\\\)` also starts with this and would
      // accept drive-relative `C:foo`, which still resolves against the cwd on that drive.
      expect(powershell).toContain("-notmatch '^([A-Za-z]:[\\\\/]|\\\\\\\\)'")
      // Why: trailing-separator normalization is what makes wrapper self-exclusion work; every
      // one of these survived mutation with the suite green.
      expect(powershell).toContain("ForEach-Object { $_.TrimEnd('\\', '/') }")
      expect(powershell).toContain("$pathEntry.TrimEnd('\\', '/')")
      expect(powershell).toContain("$dir.TrimEnd('\\', '/')")
      expect(powershell).toContain("$capturedDir.TrimEnd('\\', '/')")
      // Why: the fallback loop must skip wrapper dirs, or the wrapper can resolve to itself.
      expect(powershell).toContain(
        "$dir.TrimEnd('\\', '/'), [StringComparison]::OrdinalIgnoreCase) }) { continue }"
      )
      // Why both separators: the rooted-path regex accepts forward slashes, so a wrapper or
      // legacy directory spelled with a trailing / missed the lexical exclusion.
      expect(powershell).not.toContain("TrimEnd('\\')")
      // Why: `C:/Program Files/Git/cmd` style entries are legitimate and must stay accepted.
      expect(cmd).toContain('if "%orca_probe:~1,2%"==":/" set "orca_rooted=1"')
      // Why: the legacy-dir compare needs the same trailing-separator strip as its twins.
      expect(cmd).toContain('if "%orca_legacy_norm:~-1%."=="%orca_sep%."')
      // Why: cmd expands a whole line before evaluating `if defined`, so this strip must live in
      // a CALL body. Inline, it ran its substring syntax against an unset variable and mangled
      // the line into a syntax error. Proven on Windows 11.
      expect(cmd).toContain('if defined orca_legacy_wrapper_dir call :orca_normalize_legacy_dir')
      expect(cmd).not.toContain('if defined orca_legacy_wrapper_dir for ')
      expect(powershell).toContain('if (-not $dir) { continue }')
      expect(powershell).toContain('Test-Path -LiteralPath $candidate -PathType Leaf')
    }
  })

  it('emits Windows wrappers with CRLF line endings', () => {
    // Why: cmd resolves `call :label` by byte offset and that lookup is unreliable in LF-only
    // files — the same script worked at 2.4 KB and failed with "cannot find the batch label"
    // once it grew past ~3.7 KB. Verified on Windows.
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    for (const file of ['git.cmd', 'gh.cmd', 'git-wrapper.ps1', 'gh-wrapper.ps1']) {
      const body = readFileSync(join(win32Dir, file), 'utf8')
      expect(body, file).toContain('\r\n')
      expect(body.replaceAll('\r\n', ''), file).not.toContain('\n')
    }
  })

  it('guards both cmd PATH walks so an empty variable cannot break parsing', () => {
    // Why: `%VAR:;=" "%` on an empty variable leaves an unbalanced quote that desynchronizes
    // cmd parsing for the rest of the file, turning the not-found branch into
    // `1>&2 was unexpected at this time.` Reproduced on Windows before this guard.
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    for (const command of ['git', 'gh'] as const) {
      const cmd = readFileSync(join(win32Dir, `${command}.cmd`), 'utf8')
      expect(cmd).toContain('if not defined PATH goto :orca_path_walked')
      expect(cmd).toContain('if not defined orca_clean_path goto :orca_candidates_walked')
      for (const [guard, loop] of [
        ['if not defined PATH goto :orca_path_walked', 'for %%P in ("%PATH:;='],
        [
          'if not defined orca_clean_path goto :orca_candidates_walked',
          'for %%P in ("%orca_clean_path:;='
        ]
      ] as const) {
        expectOrdered(cmd, guard, loop)
      }
    }
  })

  it('never bakes an ambient interpreter lookup on Windows', () => {
    // Why: the POSIX tombstone is written on Windows too (Git Bash and WSL panes run it), but no
    // absolute candidate exists to a Windows process and PATH there is ';'-separated, so the
    // search cannot succeed — without this the fallback reopened the interpreter hijack.
    expect(resolvePosixTombstoneInterpreter(undefined, [], 'win32')).toBe('/bin/bash')
    expect(resolvePosixTombstoneInterpreter('C:\\Git\\bin;C:\\Windows', [], 'win32')).toBe(
      '/bin/bash'
    )
  })
})
