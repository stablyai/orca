import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  symlinkSync,
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
import type * as PosixTombstoneModule from './legacy-terminal-posix-tombstone'
import {
  readVerifiedShebangInterpreter,
  resolvePosixTombstoneInterpreter
} from './legacy-terminal-posix-tombstone'
import {
  __resetLegacyTerminalShimNeutralizationForTests,
  isLegacyTerminalShimPathEntry,
  neutralizeLegacyTerminalShimDir,
  stripLegacyTerminalShimEnv
} from './legacy-terminal-shim-dir'

const itOnPosix = process.platform === 'win32' ? it.skip : it
// Windows ignores these permissions and root bypasses them.
const itOnPosixNonRoot = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

// indexOf returns -1 for missing text; assert presence before ordering.
function expectOrdered(text: string, first: string, second: string): void {
  expect(text, `missing: ${first}`).toContain(first)
  expect(text, `missing: ${second}`).toContain(second)
  expect(text.indexOf(first)).toBeLessThan(text.indexOf(second))
}

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
    // Matching retired version 7 would make rollback mistake tombstones for active wrappers.
    const version = readFileSync(join(legacyRoot, 'VERSION'), 'utf8')
    expect(version).toBe('7-neutralized\n')
    expect(version.trim()).not.toBe('7')
  })

  itOnPosix('rejects interpreter candidates that are unusable in a shebang', () => {
    const userData = makeUserDataDir()
    const spaced = join(userData, 'a b')
    const dirNamedBash = join(userData, 'dirbin')
    mkdirSync(spaced, { recursive: true })
    mkdirSync(join(dirNamedBash, 'bash'), { recursive: true })
    writeFileSync(join(spaced, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    expect(resolvePosixTombstoneInterpreter(spaced, [], 'linux')).toBeNull()
    expect(resolvePosixTombstoneInterpreter(dirNamedBash, [], 'linux')).toBeNull()
  })

  itOnPosix('resolves the interpreter from absolute PATH entries only', () => {
    // Force the NixOS/Guix fallback while excluding cwd-based interpreter lookup.
    const userData = makeUserDataDir()
    const absDir = join(userData, 'absbin')
    const relDir = join(userData, 'relbin')
    mkdirSync(absDir, { recursive: true })
    mkdirSync(relDir, { recursive: true })
    for (const dir of [absDir, relDir]) {
      writeFileSync(join(dir, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }

    expect(resolvePosixTombstoneInterpreter(`${absDir}:/usr/bin`, [])).toBe(join(absDir, 'bash'))
    expect(resolvePosixTombstoneInterpreter(`:relbin:${absDir}`, [])).toBe(join(absDir, 'bash'))
    // Relative PATH resolves from process cwd; a tmpdir-only fixture would pass without the guard.
    const cwdRelName = `.orca-interp-${process.pid}`
    const cwdRelDir = join(process.cwd(), cwdRelName)
    mkdirSync(cwdRelDir, { recursive: true })
    try {
      writeFileSync(join(cwdRelDir, 'bash'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      expect(resolvePosixTombstoneInterpreter(`.:${cwdRelName}`, [])).toBeNull()
    } finally {
      rmSync(cwdRelDir, { recursive: true, force: true })
    }
  })

  itOnPosix('resolves its own directory even when CDPATH is set', () => {
    // CDPATH can redirect relative cd and echo into wrapper_dir, breaking lookup.
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    const realBin = join(userData, 'real-bin')
    const cdpathDir = join(userData, 'cdpath')
    mkdirSync(posixDir, { recursive: true })
    mkdirSync(realBin, { recursive: true })
    // CDPATH matches the whole relative operand, so mirror every directory segment.
    mkdirSync(join(cdpathDir, 'orca-terminal-attribution', 'posix'), { recursive: true })
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    writeFileSync(join(realBin, 'git'), "#!/bin/bash\nprintf 'REAL\\n'\n", { mode: 0o755 })

    const run = spawnSync('/bin/bash', ['orca-terminal-attribution/posix/git', '--version'], {
      cwd: userData,
      env: { CDPATH: cdpathDir, PATH: `${posixDir}:${realBin}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 20_000
    })

    expect(run.stdout).toContain('REAL')
    expect(run.status).toBe(0)
  })

  itOnPosix('fails closed instead of self-executing when it resolves to itself', () => {
    // Pin the self-exec guard: correct wrapper_dir normally hides its removal.
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    mkdirSync(posixDir, { recursive: true })
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    // A differently located symlink can point back to this wrapper despite directory exclusion.
    const otherBin = join(userData, 'other-bin')
    mkdirSync(otherBin, { recursive: true })
    symlinkSync(join(posixDir, 'git'), join(otherBin, 'git'))

    const run = spawnSync(join(posixDir, 'git'), ['--version'], {
      cwd: posixDir,
      env: { PATH: `${otherBin}:${posixDir}` },
      encoding: 'utf8',
      timeout: 20_000
    })

    expect(run.status).toBe(127)
    expect(run.stderr).toContain('could not locate git')
    // A timeout would hide repeated self-exec.
    expect(run.signal).toBeNull()

    // Correct wrapper_dir makes this defense-in-depth guard hard to reach behaviorally.
    const wrapper = readFileSync(join(posixDir, 'git'), 'utf8')
    expect(wrapper).toContain('-ef "${BASH_SOURCE[0]}"')
    // Missing external dirname previously left wrapper_dir empty and cd selected cwd.
    expect(wrapper).not.toMatch(/\$\(dirname\b/)
    expect(wrapper).toContain('CDPATH= cd -P --')
  })

  itOnPosix('rejects a distinct legacy shim directory named by the environment', () => {
    // An inherited marker can name an older install, distinct from the current wrapper directory.
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    const legacyDir = join(userData, 'legacy-shim')
    const realBin = join(userData, 'real-bin')
    for (const dir of [posixDir, legacyDir, realBin]) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    writeFileSync(join(legacyDir, 'git'), "#!/bin/bash\nprintf 'HOSTILE\\n'\n", { mode: 0o755 })
    writeFileSync(join(realBin, 'git'), "#!/bin/bash\nprintf 'REAL\\n'\n", { mode: 0o755 })

    const run = spawnSync(join(posixDir, 'git'), ['--version'], {
      env: {
        ...process.env,
        ORCA_ATTRIBUTION_SHIM_DIR: legacyDir,
        PATH: `${legacyDir}:${realBin}:/usr/bin:/bin`
      },
      encoding: 'utf8',
      timeout: 20_000
    })

    expect(run.stdout).toContain('REAL')
    expect(run.stdout).not.toContain('HOSTILE')
  })

  itOnPosix('rejects the legacy shim directory reached by a different spelling', () => {
    // Equivalent inode spellings must exclude the still-live legacy wrapper too.
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    const legacyDir = join(userData, 'legacy-shim')
    const realBin = join(userData, 'real-bin')
    for (const dir of [posixDir, legacyDir, realBin]) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    writeFileSync(join(legacyDir, 'git'), "#!/bin/bash\nprintf 'HOSTILE\\n'\n", { mode: 0o755 })
    writeFileSync(join(realBin, 'git'), "#!/bin/bash\nprintf 'REAL\\n'\n", { mode: 0o755 })
    const legacyLink = join(userData, 'legacy-link')
    symlinkSync(legacyDir, legacyLink)

    for (const spelling of [join(legacyDir, '..', 'legacy-shim'), legacyLink]) {
      const run = spawnSync(join(posixDir, 'git'), ['--version'], {
        env: {
          ...process.env,
          ORCA_ATTRIBUTION_SHIM_DIR: legacyDir,
          PATH: `${spelling}:${realBin}:/usr/bin:/bin`
        },
        encoding: 'utf8',
        timeout: 20_000
      })
      expect(run.stdout, `spelling ${spelling}`).toContain('REAL')
      expect(run.stdout, `spelling ${spelling}`).not.toContain('HOSTILE')
    }
  })

  itOnPosix('reuses the replaced wrapper shebang when no absolute bash is verifiable', () => {
    // Deleting a hashed wrapper strands existing shells at 127; preserve its verified interpreter.
    const userData = makeUserDataDir()
    const wrapper = join(userData, 'git')
    writeFileSync(wrapper, '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    expect(readVerifiedShebangInterpreter(wrapper)).toBe('/bin/bash')

    // env bash defers interpreter lookup to PATH and reopens cwd hijacking.
    writeFileSync(wrapper, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    expect(readVerifiedShebangInterpreter(wrapper)).toBeNull()

    // /bin/sh reliably exists but cannot run this Bash-specific body.
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    expect(readVerifiedShebangInterpreter(wrapper)).toBeNull()

    writeFileSync(wrapper, '#!bash\nexit 0\n', { mode: 0o755 })
    expect(readVerifiedShebangInterpreter(wrapper)).toBeNull()

    writeFileSync(wrapper, '#!/nonexistent/bash\nexit 0\n', { mode: 0o755 })
    expect(readVerifiedShebangInterpreter(wrapper)).toBeNull()

    writeFileSync(wrapper, 'no shebang at all\n', { mode: 0o755 })
    expect(readVerifiedShebangInterpreter(wrapper)).toBeNull()

    expect(readVerifiedShebangInterpreter(join(userData, 'absent'))).toBeNull()
  })

  itOnPosix('keeps the POSIX wrapper on a host where no absolute bash resolves', async () => {
    // Force resolver failure: ordinary CI bash paths otherwise hide missing fallback wiring.
    vi.resetModules()
    vi.doMock('./legacy-terminal-posix-tombstone', async () => {
      const actual = await vi.importActual<typeof PosixTombstoneModule>(
        './legacy-terminal-posix-tombstone'
      )
      return { ...actual, resolvePosixTombstoneInterpreter: () => null }
    })
    try {
      const shimDir = await import('./legacy-terminal-shim-dir')
      shimDir.__resetLegacyTerminalShimNeutralizationForTests()
      const userData = makeUserDataDir()
      const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
      mkdirSync(posixDir, { recursive: true })
      writeFileSync(join(posixDir, 'git'), '#!/bin/bash\nlegacy attribution wrapper\n', {
        mode: 0o755
      })
      // An unverifiable env shebang must be deleted rather than preserve retired attribution.
      writeFileSync(join(posixDir, 'gh'), '#!/usr/bin/env bash\nlegacy\n', { mode: 0o755 })

      shimDir.neutralizeLegacyTerminalShimDir(userData)

      const git = readFileSync(join(posixDir, 'git'), 'utf8')
      expect(git.split('\n')[0]).toBe('#!/bin/bash')
      expect(git).toContain('Orca compatibility wrapper could not locate')
      expect(existsSync(join(posixDir, 'gh'))).toBe(false)
    } finally {
      vi.doUnmock('./legacy-terminal-posix-tombstone')
      vi.resetModules()
    }
  })

  it('does not collapse .. when classifying a shim PATH entry', () => {
    // Collapsing .. through a symlink can erase a legitimate PATH entry; remote/WSL paths cannot be resolved locally.
    expect(isLegacyTerminalShimPathEntry('/tmp/old/orca-terminal-attribution/posix/../posix')).toBe(
      false
    )
    expect(isLegacyTerminalShimPathEntry('/tmp/old/orca-terminal-attribution/posix')).toBe(true)
    expect(isLegacyTerminalShimPathEntry('/tmp/old/orca-terminal-attribution/win32//')).toBe(true)
    expect(isLegacyTerminalShimPathEntry('/usr/local/bin')).toBe(false)
  })

  it('strips a captured shim directory spelled with repeated separators', () => {
    // Repeated separators must not defeat captured-directory removal.
    const posixEnv = {
      PATH: '/custom/elsewhere///:/usr/bin',
      ORCA_ATTRIBUTION_SHIM_DIR: '/custom/elsewhere'
    }
    stripLegacyTerminalShimEnv(posixEnv, 'linux')
    expect(posixEnv.PATH).toBe('/usr/bin')

    const windowsEnv = {
      Path: 'C:\\Custom\\Else\\\\;C:\\Windows',
      ORCA_ATTRIBUTION_SHIM_DIR: 'C:\\Custom\\Else'
    }
    stripLegacyTerminalShimEnv(windowsEnv, 'win32')
    expect(windowsEnv.Path).toBe('C:\\Windows')
  })

  itOnPosix(
    'ignores a relative legacy shim directory instead of resolving it against the cwd',
    () => {
      // Relative -ef operands depend on cwd and could select different real git binaries.
      const userData = makeUserDataDir()
      const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
      const safeBin = join(userData, 'safe-bin')
      const laterBin = join(userData, 'later-bin')
      for (const dir of [posixDir, safeBin, laterBin]) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

      neutralizeLegacyTerminalShimDir(userData)

      writeFileSync(join(safeBin, 'git'), "#!/bin/bash\nprintf 'SAFE\\n'\n", { mode: 0o755 })
      writeFileSync(join(laterBin, 'git'), "#!/bin/bash\nprintf 'LATER\\n'\n", { mode: 0o755 })

      const outputs = [userData, join(userData, 'orca-terminal-attribution')].map((cwd) => {
        const run = spawnSync(join(posixDir, 'git'), ['--version'], {
          cwd,
          env: {
            ...process.env,
            ORCA_ATTRIBUTION_SHIM_DIR: 'safe-bin',
            PATH: `${safeBin}:${laterBin}:/usr/bin:/bin`
          },
          encoding: 'utf8',
          timeout: 20_000
        })
        return run.stdout.trim()
      })

      expect(outputs[0]).toBe(outputs[1])
      expect(outputs[0]).toBe('SAFE')
    }
  )

  it('keeps a POSIX directory whose name ends in a backslash', () => {
    // POSIX backslashes belong to filenames; stripping them can delete a real PATH entry.
    const env = {
      PATH: '/tmp/captured\\',
      ORCA_ATTRIBUTION_SHIM_DIR: '/tmp/captured'
    }
    stripLegacyTerminalShimEnv(env, 'linux')
    expect(env.PATH).toBe('/tmp/captured\\')

    const windowsEnv = { Path: 'C:\\captured\\', ORCA_ATTRIBUTION_SHIM_DIR: 'C:\\captured' }
    stripLegacyTerminalShimEnv(windowsEnv, 'win32')
    expect(windowsEnv.Path).toBeUndefined()
  })

  itOnPosix('does not fall back to the cwd when every PATH entry is filtered out', () => {
    // An emptied PATH must not fall through to cwd-local git.
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    const hostile = join(userData, 'hostile')
    mkdirSync(posixDir, { recursive: true })
    mkdirSync(hostile, { recursive: true })
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    writeFileSync(join(hostile, 'git'), "#!/bin/bash\nprintf 'HOSTILE\\n'\n", { mode: 0o755 })

    const run = spawnSync(join(posixDir, 'git'), ['--version'], {
      cwd: hostile,
      env: { PATH: posixDir },
      encoding: 'utf8',
      timeout: 20_000
    })

    expect(run.stdout).not.toContain('HOSTILE')
    expect(run.status).toBe(127)
  })

  itOnPosix('hands the child the cleaned PATH, not the inherited one', () => {
    // Export the cleaned PATH so git hooks and credential helpers cannot rediscover legacy or cwd entries.
    const userData = makeUserDataDir()
    const posixDir = join(userData, 'orca-terminal-attribution', 'posix')
    const realBin = join(userData, 'real-bin')
    mkdirSync(posixDir, { recursive: true })
    mkdirSync(realBin, { recursive: true })
    writeFileSync(join(posixDir, 'git'), 'legacy attribution wrapper')

    neutralizeLegacyTerminalShimDir(userData)

    writeFileSync(join(realBin, 'git'), '#!/bin/bash\nprintf \'PATH=%s\\n\' "$PATH"\n', {
      mode: 0o755
    })

    const run = spawnSync(join(posixDir, 'git'), ['--version'], {
      env: { PATH: `${posixDir}:.:${realBin}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 20_000
    })

    expect(run.stdout).toContain('PATH=')
    expect(run.stdout).not.toContain('orca-terminal-attribution')
    expect(run.stdout.split('PATH=')[1]?.split(':')).not.toContain('.')
  })

  itOnPosix('does not let the cwd supply the script interpreter', async () => {
    // Interpreter lookup precedes script PATH hygiene; env bash permits checkout-local interception.
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
    // Empty POSIX PATH elements name cwd (STA-4169).
    const userData = makeUserDataDir()
    const shimDir = join(userData, 'orca-terminal-attribution', 'posix')
    const realBin = join(userData, 'real-bin')
    mkdirSync(shimDir, { recursive: true })
    mkdirSync(realBin, { recursive: true })
    writeFileSync(join(shimDir, 'git'), 'legacy attribution wrapper')
    writeFileSync(join(realBin, 'git'), "#!/usr/bin/env bash\nprintf 'REAL\\n'\n", { mode: 0o755 })

    neutralizeLegacyTerminalShimDir(userData)

    const hostile = join(userData, 'hostile')
    mkdirSync(hostile, { recursive: true })
    writeFileSync(join(hostile, 'git'), "#!/usr/bin/env bash\nprintf 'HOSTILE\\n'\n", {
      mode: 0o755
    })
    mkdirSync(join(hostile, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      join(hostile, 'node_modules', '.bin', 'git'),
      "#!/usr/bin/env bash\nprintf 'HOSTILE\\n'\n",
      { mode: 0o755 }
    )

    const result = spawnSync(join(shimDir, 'git'), ['--version'], {
      cwd: hostile,
      // Keep system dirs for the fixture shebang; the empty entry supplies the hostile cwd.
      env: { ...process.env, PATH: `${shimDir}::${realBin}:/usr/bin:/bin` },
      encoding: 'utf8'
    })

    expect(result.stdout).toContain('REAL')
    expect(result.stdout).not.toContain('HOSTILE')

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

    // A slashless BASH_SOURCE makes basename stripping return the filename and can defeat self-exclusion.
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
    expectOrdered(cmd, cmdCapture, 'set "ORCA_ATTRIBUTION_SHIM_DIR="')
    expect(cmd).toContain('for %%P in ("%PATH:;=" "%") do (')
    expect(cmd).toContain('if /I "%orca_path_entry_dir%"=="%orca_wrapper_dir%" exit /b')
    expect(cmd).toContain('if defined orca_legacy_wrapper_dir call :orca_reject_legacy_dir')
    // cmd cannot use call :label && ...; preserve the explicit flag.
    expect(cmd).toContain('if defined orca_skip_entry exit /b')
    expect(cmd).not.toContain('call :orca_reject_legacy_dir &&')
    expect(cmd).toContain('if "%orca_path_entry_dir:~-1%."=="%orca_sep%."')

    const powershell = readFileSync(join(win32Dir, 'git-wrapper.ps1'), 'utf8')
    expectOrdered(
      powershell,
      '$legacyWrapperDir = $env:ORCA_ATTRIBUTION_SHIM_DIR',
      'Remove-Item "Env:$_"'
    )
    expect(powershell).toContain('$wrapperDirs = @($wrapperDir, $legacyWrapperDir)')
    expect(powershell).toContain("$env:PATH = (($env:PATH -split ';') | Where-Object {")
    expect(powershell).toContain('[StringComparison]::OrdinalIgnoreCase')
  })

  it('leaves an install that never ran the shim untouched', () => {
    // Fresh installs need no hashed-path compatibility wrappers.
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
    chmodSync(posixDir, 0o500)
    try {
      neutralizeLegacyTerminalShimDir(userData)
      // Cover all four retry delays plus enough slack to expose an unwanted fifth.
      await vi.advanceTimersByTimeAsync(120_000)

      expect(readFileSync(join(posixDir, 'git'), 'utf8')).toBe('legacy attribution wrapper')
      const messages = warn.mock.calls.map((call) => String(call[0]))
      expect(messages.filter((message) => message.includes('neutralization attempt'))).toHaveLength(
        5
      )
      // Counts alone cannot catch incorrect attempt ordinals.
      expect(messages.some((message) => message.includes('neutralization attempt 1 failed'))).toBe(
        true
      )
      expect(messages.some((message) => message.includes('neutralization attempt 5 failed'))).toBe(
        true
      )
      expect(
        messages.some((message) => message.includes('gave up neutralizing after 5 attempts'))
      ).toBe(true)

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

  it('strips the captured shim directory when PATH spells it with a trailing separator', () => {
    // Separator variants must not keep the captured shim directory reachable.
    const posix: Record<string, string> = {
      PATH: '/custom/elsewhere/:/usr/bin',
      ORCA_ATTRIBUTION_SHIM_DIR: '/custom/elsewhere'
    }
    stripLegacyTerminalShimEnv(posix, 'linux')
    expect(posix.PATH).toBe('/usr/bin')

    const win: Record<string, string> = {
      Path: 'C:\\Custom\\Else;C:\\Windows',
      ORCA_ATTRIBUTION_SHIM_DIR: 'C:\\Custom\\Else\\'
    }
    stripLegacyTerminalShimEnv(win, 'win32')
    expect(win.Path).toBe('C:\\Windows')
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

  it('strips legacy shim entries that carry a trailing separator', () => {
    const posix: Record<string, string> = {
      PATH: '/home/u/.orca/orca-terminal-attribution/posix/:/usr/bin'
    }
    stripLegacyTerminalShimEnv(posix, 'linux')
    expect(posix.PATH).toBe('/usr/bin')

    const many: Record<string, string> = {
      PATH: '/home/u/.orca/orca-terminal-attribution/posix///:/usr/bin'
    }
    stripLegacyTerminalShimEnv(many, 'linux')
    expect(many.PATH).toBe('/usr/bin')

    const win: Record<string, string> = {
      Path: 'C:\\Users\\u\\orca-terminal-attribution\\win32\\;C:\\Windows'
    }
    stripLegacyTerminalShimEnv(win, 'win32')
    expect(win.Path).toBe('C:\\Windows')
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
