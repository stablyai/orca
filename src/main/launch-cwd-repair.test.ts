import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { runProcess } from '../shared/child-process/run-process'
import { repairLaunchCwd, stableCwdCandidates } from './launch-cwd-repair'

const WSL_WORKTREE = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\projects\\orca\\wt\\feature'
const WINDOWS_USER_DATA = 'C:\\Users\\alice\\AppData\\Roaming\\Orca'

function windowsEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ORCA_USER_DATA_PATH: WINDOWS_USER_DATA,
    LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\alice',
    SystemDrive: 'C:',
    ...overrides
  }
}

function recordingChdir(): { calls: string[]; chdir: (path: string) => void } {
  const calls: string[] = []
  return { calls, chdir: (path: string) => void calls.push(path) }
}

describe('repairLaunchCwd', () => {
  it('leaves a WSL share the app was launched from before it can be deleted', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => WSL_WORKTREE,
      // The share still resolves — this is the launch, hours before the removal.
      isDirectory: () => true,
      chdir
    })

    expect(repair).toEqual({
      outcome: 'relocated',
      from: WSL_WORKTREE,
      to: WINDOWS_USER_DATA,
      reason: 'network-share'
    })
    expect(calls).toEqual([WINDOWS_USER_DATA])
  })

  it('abandons a WSL share even when the 9P stat still claims it is there', () => {
    // Why: statSync against \\wsl.localhost is unreliable in both directions, so
    // the decision has to be made from the path shape, never from the share.
    const probed: string[] = []
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => WSL_WORKTREE,
      isDirectory: (path) => {
        probed.push(path)
        return true
      },
      chdir
    })

    expect(repair.outcome).toBe('relocated')
    expect(probed).not.toContain(WSL_WORKTREE)
    expect(calls).toEqual([WINDOWS_USER_DATA])
  })

  it('keeps a healthy native Windows working directory', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => 'C:\\Users\\alice\\projects\\orca',
      isDirectory: () => true,
      chdir
    })

    expect(repair).toEqual({ outcome: 'kept', cwd: 'C:\\Users\\alice\\projects\\orca' })
    expect(calls).toEqual([])
  })

  it('keeps a WSL share when the process is not on Windows', () => {
    // The UNC form is only a hazard for a Win32 process holding it as its cwd.
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'linux',
      env: { ORCA_USER_DATA_PATH: '/home/alice/.config/Orca', HOME: '/home/alice' },
      readCwd: () => WSL_WORKTREE,
      isDirectory: () => true,
      chdir
    })

    expect(repair.outcome).toBe('kept')
    expect(calls).toEqual([])
  })

  it('relocates off a working directory that no longer exists', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'darwin',
      env: { ORCA_USER_DATA_PATH: '/Users/alice/Library/Application Support/Orca' },
      readCwd: () => '/Users/alice/orca/wt/removed',
      isDirectory: (path) => path !== '/Users/alice/orca/wt/removed',
      chdir
    })

    expect(repair).toEqual({
      outcome: 'relocated',
      from: '/Users/alice/orca/wt/removed',
      to: '/Users/alice/Library/Application Support/Orca',
      reason: 'unresolvable'
    })
    expect(calls).toEqual(['/Users/alice/Library/Application Support/Orca'])
  })

  it('relocates when reading the working directory itself throws', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'linux',
      env: { ORCA_USER_DATA_PATH: '/home/alice/.config/Orca' },
      readCwd: () => {
        throw Object.assign(new Error('ENOENT: uv_cwd'), { code: 'ENOENT' })
      },
      isDirectory: () => true,
      chdir
    })

    expect(repair).toEqual({
      outcome: 'relocated',
      from: null,
      to: '/home/alice/.config/Orca',
      reason: 'unresolvable'
    })
    expect(calls).toEqual(['/home/alice/.config/Orca'])
  })

  it('leaves a plain SMB share too, which Win32 locks no better than a 9P one', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => '\\\\fileserver\\team\\orca\\wt\\feature',
      isDirectory: () => true,
      chdir
    })

    expect(repair).toMatchObject({ outcome: 'relocated', reason: 'network-share' })
    expect(calls).toEqual([WINDOWS_USER_DATA])
  })

  it('keeps an extended-length local path, which is not a share at all', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => '\\\\?\\C:\\Users\\alice\\projects\\orca',
      isDirectory: () => true,
      chdir
    })

    expect(repair.outcome).toBe('kept')
    expect(calls).toEqual([])
  })

  it('leaves an extended-length UNC share before it can be deleted', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => '\\\\?\\UNC\\fileserver\\team\\orca\\wt\\feature',
      isDirectory: () => true,
      chdir
    })

    expect(repair).toMatchObject({ outcome: 'relocated', reason: 'network-share' })
    expect(calls).toEqual([WINDOWS_USER_DATA])
  })

  it('never relocates onto another share', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv({
        ORCA_USER_DATA_PATH: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.config\\Orca',
        LOCALAPPDATA: undefined
      }),
      readCwd: () => WSL_WORKTREE,
      isDirectory: () => true,
      chdir
    })

    expect(calls).toEqual(['C:\\Users\\alice'])
    expect(repair).toMatchObject({ outcome: 'relocated', to: 'C:\\Users\\alice' })
  })

  it('skips a stable candidate that is missing and falls through to the next', () => {
    const { calls, chdir } = recordingChdir()

    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => WSL_WORKTREE,
      isDirectory: (path) => path === 'C:\\',
      chdir
    })

    expect(calls).toEqual(['C:\\'])
    expect(repair).toMatchObject({ outcome: 'relocated', to: 'C:\\' })
  })

  it('reports unrepaired when no stable directory can be entered', () => {
    // The daemon turns this into its "worktree deleted? restart Orca" error, so
    // the failure has to stay distinguishable from a successful relocation.
    const repair = repairLaunchCwd({
      platform: 'win32',
      env: windowsEnv(),
      readCwd: () => WSL_WORKTREE,
      isDirectory: () => false,
      chdir: () => {
        throw new Error('chdir should not be reached')
      }
    })

    expect(repair).toEqual({
      outcome: 'unrepaired',
      from: WSL_WORKTREE,
      reason: 'network-share'
    })
  })

  it('reports unrepaired when every chdir is rejected', () => {
    const repair = repairLaunchCwd({
      platform: 'linux',
      env: { ORCA_USER_DATA_PATH: '/home/alice/.config/Orca' },
      readCwd: () => '/home/alice/orca/wt/removed',
      isDirectory: (path) => path !== '/home/alice/orca/wt/removed',
      chdir: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
    })

    expect(repair).toMatchObject({ outcome: 'unrepaired', reason: 'unresolvable' })
  })
})

describe('stableCwdCandidates', () => {
  it('prefers userData and drops duplicate and share entries', () => {
    expect(
      stableCwdCandidates({
        platform: 'win32',
        env: windowsEnv({
          LOCALAPPDATA: WINDOWS_USER_DATA,
          HOMEDRIVE: 'C:',
          HOMEPATH: '\\Users\\alice'
        }),
        homeDirectory: () => '\\\\wsl.localhost\\Ubuntu\\home\\alice'
      })
    ).toEqual([WINDOWS_USER_DATA, 'C:\\Users\\alice', 'C:\\'])
  })

  it('falls back to the filesystem root when nothing else is configured', () => {
    expect(stableCwdCandidates({ platform: 'linux', env: {}, homeDirectory: () => '' })).toEqual([
      '/'
    ])
  })
})

describe('a working directory deleted under a live process', () => {
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
  })

  // Why not on Windows: Win32 holds an open handle on a native cwd, so the
  // directory cannot be removed at all — the reported failure needs a WSL 9P
  // share, which no Windows CI runner can be assumed to have. The share-shaped
  // half of the fix is covered above, from the path shape rather than the disk.
  it.skipIf(process.platform === 'win32')(
    'recovers a real process and keeps spawning subprocesses and git',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-launch-cwd-'))
      const launchCwd = resolve(root, 'wt', 'feature')
      await mkdir(launchCwd, { recursive: true })

      // Facts are captured before asserting: while the cwd is gone, anything the
      // assertion machinery resolves against it is unreliable, so the window
      // stays as small as it can be.
      let repairOutcome: ReturnType<typeof repairLaunchCwd>
      let repairedCwd: string
      let repairedCwdExists: boolean
      let spawnExitCode: number | null
      let gitExitCode: number | null
      let gitStdout: string
      try {
        process.chdir(launchCwd)
        await rm(launchCwd, { recursive: true, force: true })

        repairOutcome = repairLaunchCwd({ env: { ORCA_USER_DATA_PATH: root } })
        repairedCwd = process.cwd()
        repairedCwdExists = existsSync(repairedCwd)
        // Neither spawn passes a cwd, so both inherit the process's — the exact
        // shape that fails for the rest of the session on Windows once the
        // inherited directory is a dead 9P path.
        const spawned = await runProcess({
          program: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 30_000
        })
        spawnExitCode = spawned.code
        const git = await runProcess({ program: 'git', args: ['--version'], timeoutMs: 30_000 })
        gitExitCode = git.code
        gitStdout = git.stdout
      } finally {
        process.chdir(originalCwd)
        await rm(root, { recursive: true, force: true })
      }

      expect(repairOutcome).toMatchObject({
        outcome: 'relocated',
        reason: 'unresolvable',
        to: root
      })
      expect(repairedCwd).not.toBe(launchCwd)
      expect(repairedCwdExists).toBe(true)
      expect(spawnExitCode).toBe(0)
      expect(gitExitCode).toBe(0)
      expect(gitStdout).toContain('git version')
    }
  )
})
