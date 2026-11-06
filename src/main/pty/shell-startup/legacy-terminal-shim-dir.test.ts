import { spawn, spawnSync } from 'node:child_process'
import { symlinkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLegacyTerminalShimNeutralizationForTests,
  neutralizeLegacyTerminalShimDir
} from './legacy-terminal-shim-dir'

const itOnPosix = process.platform === 'win32' ? it.skip : it
void (process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it)

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
