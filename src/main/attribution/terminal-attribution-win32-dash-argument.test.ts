import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTerminalAttributionEnv } from './terminal-attribution'

// Why (#12046 follow-up): `powershell.exe -File <script> ... -` fails argument
// binding with PSArgumentException before the script runs, so any command
// carrying a bare `-` must never be dispatched to the PowerShell wrapper.
describe('win32 attribution wrappers with a bare `-` argument', () => {
  let tmpRoot: string | null = null

  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { force: true, recursive: true })
      tmpRoot = null
    }
  })

  function shimDir(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'orca-attribution-dash-'))
    const userDataPath = join(tmpRoot, 'user-data')
    const baseEnv: Record<string, string> = {
      Path: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows'
    }
    applyTerminalAttributionEnv(baseEnv, {
      enabled: true,
      platform: 'win32',
      shellFamily: 'native-windows',
      userDataPath
    })
    return join(userDataPath, 'orca-terminal-attribution', 'win32')
  }

  it('guards the git PowerShell dispatch behind a bare-dash check', () => {
    const wrapper = readFileSync(join(shimDir(), 'git.cmd'), 'utf8')
    const guardAt = wrapper.indexOf('call :orca_has_bare_dash %*')
    const dispatchAt = wrapper.indexOf('powershell.exe')

    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(dispatchAt)
    expect(wrapper).toContain('if not errorlevel 1 goto run')
    expect(wrapper).toContain(':orca_has_bare_dash')
    expect(wrapper).toContain('if "%~1"=="-" exit /b 0')
  })

  it('guards the gh PowerShell dispatch behind a bare-dash check', () => {
    const wrapper = readFileSync(join(shimDir(), 'gh.cmd'), 'utf8')
    const guardAt = wrapper.indexOf('call :orca_has_bare_dash %*')
    const dispatchAt = wrapper.indexOf('powershell.exe')

    expect(guardAt).toBeGreaterThan(-1)
    expect(guardAt).toBeLessThan(dispatchAt)
    expect(wrapper).toContain(':orca_has_bare_dash')
  })

  const itWindows = process.platform === 'win32' ? it : it.skip

  // Why: the guard exists for a runtime failure, so the real regression is a
  // real `git commit -F -` through the generated wrapper on a real Windows host.
  itWindows('commits a message piped through `git commit -F -`', () => {
    const dir = shimDir()
    const gitCmd = join(dir, 'git.cmd')
    const repo = mkdtempSync(join(tmpdir(), 'orca-attribution-dash-repo-'))
    try {
      const git = (...args: string[]): void => {
        spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
      }
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      writeFileSync(join(repo, 'a.txt'), 'hello\n')
      git('add', '.')

      const env = {
        ...process.env,
        ORCA_ENABLE_GIT_ATTRIBUTION: '1',
        ORCA_REAL_GIT: spawnSync('where', ['git.exe'], { encoding: 'utf8' }).stdout.split(
          /\r?\n/
        )[0]
      }
      const result = spawnSync('cmd.exe', ['/d', '/c', gitCmd, 'commit', '-F', '-'], {
        cwd: repo,
        env,
        input: 'piped subject\n',
        encoding: 'utf8'
      })

      expect(result.stderr).not.toContain('PSArgumentException')
      expect(result.status).toBe(0)
      expect(
        spawnSync('git', ['log', '-1', '--format=%B'], { cwd: repo, encoding: 'utf8' }).stdout
      ).toContain('piped subject')
    } finally {
      rmSync(repo, { force: true, recursive: true })
    }
  })
})
