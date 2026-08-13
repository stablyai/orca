import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolvePosixTombstoneInterpreter } from './legacy-terminal-posix-tombstone'
import {
  __resetLegacyTerminalShimNeutralizationForTests,
  neutralizeLegacyTerminalShimDir,
  stripLegacyTerminalShimEnv
} from './legacy-terminal-shim-dir'

const itOnPosix = process.platform === 'win32' ? it.skip : it
// Why: the failure case uses directory permissions, which Windows ignores and root bypasses.
const itOnPosixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

describe('legacy terminal shim neutralization', () => {
  const tempRoots: string[] = []

  const makeUserDataDir = (): string => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-legacy-shim-'))
    tempRoots.push(userData)
    return userData
  }

  beforeEach(() => {
    __resetLegacyTerminalShimNeutralizationForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('atomically replaces the legacy command paths with executable tombstones', () => {
    const userData = makeUserDataDir()
    const legacyRoot = join(userData, 'orca-terminal-attribution')
    const posixDir = join(legacyRoot, 'posix')
    const win32Dir = join(legacyRoot, 'win32')
    mkdirSync(posixDir, { recursive: true })
    mkdirSync(win32Dir, { recursive: true })
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')
    writeFileSync(join(win32Dir, 'gh.cmd'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    for (const path of [
      join(posixDir, 'git'),
      join(posixDir, 'gh'),
      join(win32Dir, 'git.cmd'),
      join(win32Dir, 'gh.cmd')
    ]) {
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).not.toContain('Co-authored-by: Orca')
      if (process.platform !== 'win32') {
        expect(statSync(path).mode & 0o111).not.toBe(0)
      }
    }
    // Why: must not equal the retired shim's own '7', or a rolled-back build treats its wrappers
    // as current and never rewrites them.
    const version = readFileSync(join(legacyRoot, 'VERSION'), 'utf8')
    expect(version).toBe('7-neutralized\n')
    expect(version.trim()).not.toBe('7')
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
    expect(cmd.indexOf('if not exist "%orca_real%"')).toBeLessThan(
      cmd.indexOf(':orca_try_candidate')
    )
    const powershell = readFileSync(join(win32Dir, 'git-wrapper.ps1'), 'utf8')
    expect(powershell).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(powershell).toContain('$realCommand = $null')
    expect(powershell.indexOf('[StringComparison]::OrdinalIgnoreCase')).toBeLessThan(
      powershell.indexOf('Test-Path -LiteralPath $realCommand')
    )
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
      expect(cmd).toContain('for %%P in ("%orca_clean_path:;=" "%") do call :orca_try_candidate')
      expect(cmd).toContain(`if exist "%orca_candidate_dir%\\${command}.exe"`)
      // Why: %~f preserves a trailing separator; without normalizing, a wrapper-dir entry
      // spelled with one escapes self-exclusion and the wrapper tail-loops on itself.
      // Why: `if "%var:~-1%"=="\\"` breaks cmd's parser, so the trailing separator is stripped
      // with a sentinel instead. Verified on Windows.
      expect(cmd).toContain('set "orca_candidate_dir=%orca_candidate_dir:\\#=#%"')
      // A candidate inside the wrapper directory must still be rejected, compared against the
      // cached wrapper dir because %~dp0 is rebound inside a CALL.
      expect(cmd).toContain('if /I "%orca_candidate_dir%\\"=="%orca_wrapper_dir%" exit /b')
      // Relative entries resolve against the cwd, so they must be rejected like empty ones.
      // Why: the rooted-path test must not shell out — an external tool would itself be
      // resolved from the cwd, reintroducing the hijack.
      expect(cmd).not.toContain('findstr')
      expect(cmd).toContain('if "%orca_candidate:~1,2%"==":\\" goto orca_candidate_rooted')
      expect(cmd).toContain('if "%orca_candidate:~0,2%"=="\\\\" goto orca_candidate_rooted')
      // Why: these two guards are the only thing stopping an empty element reaching the cwd on
      // Windows; deleting either left every other assertion green.
      expect(cmd).toContain('if "%~1"=="" exit /b')

      const powershell = readFileSync(join(win32Dir, `${command}-wrapper.ps1`), 'utf8')
      expect(powershell).not.toContain('Get-Command')
      expect(powershell).toContain("($env:PATH -split ';')")
      // Why: the rooted check must reject drive-relative 'C:foo', which still resolves against
      // the cwd — so the IsPathRooted call must be gone, replaced by an explicit prefix match.
      expect(powershell).not.toContain('[IO.Path]::IsPathRooted(')
      expect(powershell).toContain("-notmatch '^([A-Za-z]:")
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
        expect(cmd.indexOf(guard)).toBeGreaterThan(-1)
        expect(cmd.indexOf(guard)).toBeLessThan(cmd.indexOf(loop))
      }
    }
  })

  itOnPosix('resolves the interpreter from absolute PATH entries only', () => {
    // Why: with no well-known bash (NixOS/Guix), the fallback search must still refuse relative
    // and empty entries — those mean the current directory, the exposure being closed.
    const userData = makeUserDataDir()
    const absDir = join(userData, 'absbin')
    const relDir = join(userData, 'relbin')
    mkdirSync(absDir, { recursive: true })
    mkdirSync(relDir, { recursive: true })
    for (const dir of [absDir, relDir]) {
      writeFileSync(join(dir, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }

    // No well-known candidates: force the PATH search.
    expect(resolvePosixTombstoneInterpreter(`${absDir}:/usr/bin`, [])).toBe(join(absDir, 'bash'))
    // Relative and empty entries must be skipped even though they contain an executable bash.
    expect(resolvePosixTombstoneInterpreter(`:relbin:${absDir}`, [])).toBe(join(absDir, 'bash'))
    expect(resolvePosixTombstoneInterpreter('.:relbin', [])).toBe('/usr/bin/env bash')
  })

  itOnPosix('does not let the cwd supply the script interpreter', async () => {
    // Why: the shebang is resolved before any of the script's own PATH hygiene runs, so with
    // `env` an empty or relative PATH element lets an untrusted checkout supply bash itself.
    const userData = makeUserDataDir()
    const shimDir = join(userData, 'orca-terminal-attribution', 'posix')
    const realBin = join(userData, 'real-bin')
    const hostile = join(userData, 'hostile')
    for (const dir of [shimDir, realBin, hostile]) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(join(shimDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    expect(readFileSync(join(shimDir, 'git'), 'utf8').split('\n')[0]).not.toContain('/usr/bin/env')

    writeFileSync(join(realBin, 'git'), "#!/bin/bash\nprintf 'REAL\\n'\n", { mode: 0o755 })
    writeFileSync(join(hostile, 'bash'), "#!/bin/sh\nprintf 'HOSTILE-BASH\\n'\nexit 66\n", {
      mode: 0o755
    })

    for (const hostilePath of [
      `${shimDir}::${realBin}:/usr/bin:/bin`,
      `${shimDir}:.:${realBin}:/usr/bin:/bin`
    ]) {
      const run = spawnSync(join(shimDir, 'git'), ['--version'], {
        cwd: hostile,
        env: { ...process.env, PATH: hostilePath },
        encoding: 'utf8'
      })
      expect(run.stdout, `PATH=${hostilePath}`).toContain('REAL')
      expect(run.stdout, `PATH=${hostilePath}`).not.toContain('HOSTILE-BASH')
    }
  })

  itOnPosix('does not let an empty PATH element resolve the command from the cwd', async () => {
    // Why (STA-4169): an empty PATH element means the current directory on POSIX.
    const userData = makeUserDataDir()
    const shimDir = join(userData, 'orca-terminal-attribution', 'posix')
    const realBin = join(userData, 'real-bin')
    mkdirSync(shimDir, { recursive: true })
    mkdirSync(realBin, { recursive: true })
    writeFileSync(join(shimDir, 'git'), 'legacy attribution wrapper')
    writeFileSync(join(realBin, 'git'), "#!/usr/bin/env bash\nprintf 'REAL\\n'\n", { mode: 0o755 })

    neutralizeLegacyTerminalShimDir(userData)

    // A hostile cwd containing its own `git`, reached only via the empty PATH element.
    const hostile = join(userData, 'hostile')
    mkdirSync(hostile, { recursive: true })
    writeFileSync(join(hostile, 'git'), "#!/usr/bin/env bash\nprintf 'HOSTILE\\n'\n", {
      mode: 0o755
    })
    // Reachable only through a relative PATH entry resolved against the hostile cwd.
    mkdirSync(join(hostile, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      join(hostile, 'node_modules', '.bin', 'git'),
      "#!/usr/bin/env bash\nprintf 'HOSTILE\\n'\n",
      { mode: 0o755 }
    )

    const result = spawnSync(join(shimDir, 'git'), ['--version'], {
      cwd: hostile,
      // Why: keep real system dirs so the fixture's `env bash` shebang still resolves; the
      // empty element between shimDir and realBin is the cwd exposure under test.
      env: { ...process.env, PATH: `${shimDir}::${realBin}:/usr/bin:/bin` },
      encoding: 'utf8'
    })

    expect(result.stdout).toContain('REAL')
    expect(result.stdout).not.toContain('HOSTILE')

    // Why: every spelling that means "current directory" must lose — a leading/trailing empty
    // element, and any relative entry (`.`, or a repo-local bin dir).
    for (const cwdSpelling of [
      `:${realBin}:/usr/bin:/bin`,
      `${realBin}:/usr/bin:/bin:`,
      `.:${realBin}:/usr/bin:/bin`,
      `..:${realBin}:/usr/bin:/bin`,
      `node_modules/.bin:${realBin}:/usr/bin:/bin`
    ]) {
      const run = spawnSync(join(shimDir, 'git'), ['--version'], {
        cwd: hostile,
        env: { ...process.env, PATH: cwdSpelling },
        encoding: 'utf8'
      })
      expect(run.stdout, `PATH=${cwdSpelling}`).toContain('REAL')
      expect(run.stdout, `PATH=${cwdSpelling}`).not.toContain('HOSTILE')
    }

    // Why: invoked with no slash in $0, `${BASH_SOURCE%/*}` yields the file name rather than a
    // directory, so self-exclusion missed the shim dir and the lookup resolved back to itself.
    const noSlash = spawnSync('bash', ['git', '--version'], {
      cwd: shimDir,
      env: { ...process.env, PATH: `${shimDir}:${realBin}:/usr/bin:/bin` },
      encoding: 'utf8'
    })
    expect(noSlash.stdout).toContain('REAL')
  })

  it('removes every Windows PATH occurrence of both captured wrapper directories', () => {
    const userData = makeUserDataDir()
    const win32Dir = join(userData, 'orca-terminal-attribution', 'win32')
    mkdirSync(win32Dir, { recursive: true })

    neutralizeLegacyTerminalShimDir(userData)

    const cmd = readFileSync(join(win32Dir, 'git.cmd'), 'utf8')
    const cmdCapture = 'set "orca_legacy_wrapper_dir=%ORCA_ATTRIBUTION_SHIM_DIR%"'
    expect(cmd.indexOf(cmdCapture)).toBeLessThan(cmd.indexOf('set "ORCA_ATTRIBUTION_SHIM_DIR="'))
    expect(cmd).toContain('for %%P in ("%PATH:;=" "%") do call :orca_append_path "%%~P"')
    expect(cmd).toContain('if /I "%orca_path_entry_dir%"=="%orca_wrapper_dir%" exit /b')
    expect(cmd).toContain('if defined orca_legacy_wrapper_dir call :orca_reject_legacy_dir')
    // Why: `call :label && ...` is not valid cmd; the flag variable is what makes it work.
    expect(cmd).toContain('if defined orca_skip_entry exit /b')
    expect(cmd).not.toContain('call :orca_reject_legacy_dir &&')
    expect(cmd).toContain('set "orca_path_entry_dir=%orca_path_entry_dir:\\#=#%"')

    const powershell = readFileSync(join(win32Dir, 'git-wrapper.ps1'), 'utf8')
    expect(powershell.indexOf('$legacyWrapperDir = $env:ORCA_ATTRIBUTION_SHIM_DIR')).toBeLessThan(
      powershell.indexOf('Remove-Item "Env:$_"')
    )
    expect(powershell).toContain('$wrapperDirs = @($wrapperDir, $legacyWrapperDir)')
    expect(powershell).toContain("$env:PATH = (($env:PATH -split ';') | Where-Object {")
    expect(powershell).toContain('[StringComparison]::OrdinalIgnoreCase')
  })

  it('leaves an install that never ran the shim untouched', () => {
    // Why: a clean install has no resolved wrapper paths to keep alive, so writing tombstones
    // there would recreate the very directory the removal deleted.
    const userData = makeUserDataDir()

    expect(() => neutralizeLegacyTerminalShimDir(userData)).not.toThrow()
    expect(existsSync(join(userData, 'orca-terminal-attribution'))).toBe(false)
  })

  itOnPosixNonRoot('retries a startup failure in-process and latches after success', async () => {
    vi.useFakeTimers()
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    const gitWrapper = join(posixDir, 'git')
    mkdirSync(posixDir, { recursive: true })
    writeFileSync(gitWrapper, 'legacy attribution wrapper')
    chmodSync(posixDir, 0o500)
    try {
      neutralizeLegacyTerminalShimDir(userData)
      expect(readFileSync(gitWrapper, 'utf8')).toBe('legacy attribution wrapper')
    } finally {
      chmodSync(posixDir, 0o700)
    }

    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(readFileSync(gitWrapper, 'utf8')).not.toContain('legacy attribution wrapper')

      writeFileSync(gitWrapper, 'recreated after success')
      neutralizeLegacyTerminalShimDir(userData)
      expect(readFileSync(gitWrapper, 'utf8')).toBe('recreated after success')
    } finally {
      vi.useRealTimers()
    }
  })

  itOnPosixNonRoot('warns and stops retrying once the ladder is exhausted', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    mkdirSync(posixDir, { recursive: true })
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')
    // Why: keep every attempt failing so the ladder runs to exhaustion.
    chmodSync(posixDir, 0o500)
    try {
      neutralizeLegacyTerminalShimDir(userData)
      // 1s + 5s + 15s + 30s covers every configured delay, plus slack for a fifth that must not fire.
      await vi.advanceTimersByTimeAsync(120_000)

      expect(readFileSync(join(posixDir, 'git'), 'utf8')).toBe('legacy attribution wrapper')
      const messages = warn.mock.calls.map((call) => String(call[0]))
      expect(messages.filter((message) => message.includes('neutralization attempt'))).toHaveLength(
        5
      )
      // Why: pin the ordinals too — the count alone would not catch an off-by-one.
      expect(messages.some((message) => message.includes('neutralization attempt 1 failed'))).toBe(
        true
      )
      expect(messages.some((message) => message.includes('neutralization attempt 5 failed'))).toBe(
        true
      )
      // Why: the give-up count must agree with the last per-attempt line, not the retry counter.
      expect(
        messages.some((message) => message.includes('gave up neutralizing after 5 attempts'))
      ).toBe(true)

      // Exhausted means quiet: no further timers, so no further warnings.
      warn.mockClear()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      chmodSync(posixDir, 0o700)
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  itOnPosix('keeps a real Bash command hash working with trailing PATH separators', async () => {
    const userData = makeUserDataDir()
    const shimDir = join(userData, 'orca-terminal-attribution', 'posix')
    const shimGit = join(shimDir, 'git')
    const realBin = join(userData, 'real-bin')
    const realGit = join(realBin, 'git')
    mkdirSync(shimDir, { recursive: true })
    mkdirSync(realBin, { recursive: true })
    writeFileSync(shimGit, '#!/usr/bin/env bash\nexit 99\n', { mode: 0o755 })
    writeFileSync(
      realGit,
      "#!/usr/bin/env bash\nprintf 'arg=<%s>\\n' \"$@\"\ncat\nprintf 'fixture stderr\\n' >&2\nexit 23\n",
      { mode: 0o755 }
    )
    const child = spawn('bash', ['--noprofile', '--norc'], {
      cwd: shimDir,
      env: {
        ...process.env,
        PATH: `${shimDir}//::${realBin}:${process.env.PATH ?? ''}`,
        ORCA_ENABLE_GIT_ATTRIBUTION: '1',
        ORCA_GIT_COMMIT_TRAILER: 'Co-authored-by: Orca <help@stably.ai>',
        ORCA_ATTRIBUTION_SHIM_DIR: ''
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const ready = waitForOutput(child.stdout, '__ORCA_HASH_READY__\n')
    child.stdin.write(`hash -p ${quoteBash(shimGit)} git\nprintf '__ORCA_HASH_READY__\\n'\n`)

    try {
      await ready
    } catch (error) {
      child.kill('SIGKILL')
      throw error
    }
    neutralizeLegacyTerminalShimDir(userData)
    const closed = waitForChildClose(child, 2_000)
    child.stdin.end("printf 'stdin payload\\n' | git commit -m 'subject with spaces'; exit $?\n")

    try {
      expect(await closed).toBe(23)
    } finally {
      child.kill('SIGKILL')
    }
    expect(stdout).toContain('arg=<commit>\narg=<-m>\narg=<subject with spaces>\nstdin payload\n')
    expect(stdout).not.toContain('Co-authored-by: Orca')
    expect(stderr).toBe('fixture stderr\n')
  })

  it('drops inherited shim env and its PATH entry without touching real entries', () => {
    const env: Record<string, string> = {
      PATH: `/home/u/.orca/orca-terminal-attribution/posix:/usr/local/bin:/usr/bin`,
      ORCA_ENABLE_GIT_ATTRIBUTION: '1',
      ORCA_GIT_COMMIT_TRAILER: 'Co-authored-by: Orca <help@stably.ai>',
      ORCA_GH_PR_FOOTER: 'footer',
      ORCA_GH_ISSUE_FOOTER: 'footer',
      ORCA_ATTRIBUTION_SHIM_DIR: '/home/u/.orca/orca-terminal-attribution/posix',
      ORCA_REAL_GIT: '/usr/bin/git',
      ORCA_REAL_GH: '/usr/bin/gh',
      HOME: '/home/u'
    }

    stripLegacyTerminalShimEnv(env, 'linux')

    expect(env).toEqual({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/u' })
  })

  it('uses the captured POSIX shim directory literally when it contains a colon', () => {
    const shimDir = '/tmp/orca:user/orca-terminal-attribution/posix'
    const env: Record<string, string> = {
      PATH: `/usr/local/bin:${shimDir}:/usr/bin`,
      ORCA_ATTRIBUTION_SHIM_DIR: shimDir
    }

    stripLegacyTerminalShimEnv(env, 'linux')

    expect(env).toEqual({ PATH: '/usr/local/bin:/usr/bin' })
  })

  it('treats legacy Windows environment keys case-insensitively', () => {
    const shimDir = 'C:\\Users\\orca;user\\orca-terminal-attribution\\win32'
    const env: Record<string, string> = {
      Path: `${shimDir};C:\\Windows\\System32`,
      orca_attribution_shim_dir: shimDir,
      Orca_Enable_Git_Attribution: '1',
      orca_real_git: 'C:\\Git\\git.exe'
    }

    stripLegacyTerminalShimEnv(env, 'win32')

    expect(env).toEqual({ Path: 'C:\\Windows\\System32' })
  })

  it('strips legacy entries from every Windows PATH spelling', () => {
    const env: Record<string, string> = {
      PATH: 'C:\\Orca\\orca-terminal-attribution\\win32',
      Path: 'C:\\Orca\\orca-terminal-attribution\\win32;C:\\Windows\\System32'
    }

    stripLegacyTerminalShimEnv(env, 'win32')

    expect(env.PATH).toBeUndefined()
    expect(env.Path).toBe('C:\\Windows\\System32')
  })

  it('matches a re-cased Windows shim path', () => {
    const env: Record<string, string> = {
      Path: 'C:\\Orca\\Orca-Terminal-Attribution\\Win32;C:\\Windows\\System32'
    }

    stripLegacyTerminalShimEnv(env, 'win32')

    expect(env.Path).toBe('C:\\Windows\\System32')
  })

  it('preserves explicit empty PATH values', () => {
    const windowsEnv: Record<string, string> = { PATH: '', Path: 'C:\\Windows' }
    const posixEnv: Record<string, string> = { PATH: '' }

    stripLegacyTerminalShimEnv(windowsEnv, 'win32')
    stripLegacyTerminalShimEnv(posixEnv, 'linux')

    expect(windowsEnv).toEqual({ PATH: '', Path: 'C:\\Windows' })
    expect(posixEnv).toEqual({ PATH: '' })
  })

  it('keeps neighbouring directories that merely share the name prefix', () => {
    const env: Record<string, string> = {
      PATH: '/opt/orca-terminal-attribution:/opt/orca-terminal-attribution/custom-tools:/home/u/orca-terminal-attribution-notes/bin:/usr/bin'
    }

    stripLegacyTerminalShimEnv(env, 'linux')

    expect(env.PATH).toBe(
      '/opt/orca-terminal-attribution:/opt/orca-terminal-attribution/custom-tools:/home/u/orca-terminal-attribution-notes/bin:/usr/bin'
    )
  })

  it('leaves an unrelated PATH untouched', () => {
    const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin' }
    stripLegacyTerminalShimEnv(env, 'linux')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
  })
})

function quoteBash(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function waitForOutput(stream: NodeJS.ReadableStream, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const onData = (chunk: string | Buffer): void => {
      output += chunk.toString()
      if (output.includes(marker)) {
        cleanup()
        resolve()
      }
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error(`Bash exited before emitting ${marker}`))
    }
    const cleanup = (): void => {
      stream.off('data', onData)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.on('end', onEnd)
  })
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Bash did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('close', (exitCode) => {
      clearTimeout(timeout)
      resolve(exitCode)
    })
  })
}
