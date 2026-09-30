import { mkdtempSync, rmdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import { confirmPtyShellForeground } from '../daemon/pty-subprocess/pty-shell-foreground-confirmation'
import { createPtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'
import { spawnNativeDaemonPty } from '../daemon/pty-subprocess/native-pty-spawn'
import { canUseBunPty, spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { createWindowsBunPtyLaunch } from '../daemon/pty-subprocess/windows-bun-pty-launch'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import type { PtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'
import type { PtySubprocessOptions } from '../daemon/pty-subprocess'
import { isGitForWindowsBashLauncherPath, resolveGitBashPath } from '../git-bash'
import { readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

async function spawnPlannedPane(
  plan: PtyShellLaunchPlan,
  env: Record<string, string>,
  opts: PtySubprocessOptions
): ReturnType<typeof spawnNativeDaemonPty> {
  return spawnNativeDaemonPty(
    { ...plan, env, cols: opts.cols, rows: opts.rows },
    {
      canUseBunPty,
      spawnBunPty: (args) =>
        spawnBunPty(args, {
          // Source tests use the TS worker; packaged hosts resolve their adjacent JS worker.
          createWindowsLaunch: (launch) =>
            createWindowsBunPtyLaunch(launch, {
              workerPath: join(__dirname, '../daemon/pty-subprocess/windows-bun-pty-gate-entry.ts')
            })
        })
    }
  )
}

/** Drives a live pane through prompt -> foreground command -> interrupt -> background job. */
async function proveIdlePromptCycle(
  spawned: Awaited<ReturnType<typeof spawnNativeDaemonPty>>,
  expectedJobSize: number
): Promise<void> {
  const proc = spawned.process
  let output = ''
  let dead = false
  proc.onData((chunk) => {
    output += chunk
  })
  proc.onExit(() => {
    dead = true
  })
  const confirm = (): Promise<boolean> =>
    confirmPtyShellForeground({
      process: proc,
      shellPath: spawned.shellPath,
      isDead: () => dead
    })
  try {
    await vi.waitFor(() => expect(output).toContain('$'), { timeout: 20_000 })
    await vi.waitFor(() => expect(readWindowsPtyJobProcessIds(proc)?.size).toBe(expectedJobSize), {
      timeout: 5_000
    })
    await vi.waitFor(async () => expect(await confirm(), 'initial prompt').toBe(true), {
      timeout: 5_000
    })

    // Interrupt only after the child is ready, not during a transient shell fork.
    proc.write(
      "node -e \"console.log(['ORCA','FOREGROUND_READY'].join('_')); setInterval(() => {}, 1000)\"\r"
    )
    await vi.waitFor(() => expect(output).toContain('ORCA_FOREGROUND_READY'), {
      timeout: 10_000
    })
    await vi.waitFor(async () => expect(await confirm()).toBe(false), { timeout: 10_000 })

    proc.write('\x03')
    await vi.waitFor(
      async () => {
        expect(dead, 'terminal survived foreground interrupt').toBe(false)
        expect(await confirm(), 'prompt after interrupt').toBe(true)
      },
      { timeout: 10_000 }
    )

    proc.write('sleep 60 &\r')
    await vi.waitFor(async () => expect(await confirm()).toBe(false), { timeout: 10_000 })
  } finally {
    proc.kill()
  }
}

describeOnWindows("Git Bash launcher shell proof with Orca's real launch", () => {
  let userData: string
  const previousUserData = process.env.ORCA_USER_DATA_PATH

  beforeAll(() => {
    // The launch plan writes shell-ready wrappers under the user-data root.
    userData = mkdtempSync(join(tmpdir(), 'orca-git-bash-proof-'))
    process.env.ORCA_USER_DATA_PATH = userData
  })

  afterAll(() => {
    if (previousUserData === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserData
    }
    removeTreeSync(userData)
  })

  it.each([
    ['login shell', {}],
    // Why: with the Codex preflight set, the exec'd shell runs Orca's --rcfile wrapper.
    ['rcfile wrapper', { ORCA_CODEX_LAUNCH_PREFLIGHT: 'C:\\orca-missing-preflight.exe' }]
  ])(
    'confirms an idle %s prompt, refutes a running command, and confirms again',
    async (_label, extraEnv) => {
      const opts: PtySubprocessOptions = {
        sessionId: 'git-bash-shell-proof',
        cols: 120,
        rows: 30,
        cwd: tmpdir(),
        shellOverride: WINDOWS_GIT_BASH_SHELL,
        env: extraEnv
      }
      const env = createDaemonPtyEnvironment(opts)
      const plan = createPtyShellLaunchPlan(opts, env)
      expect(isGitForWindowsBashLauncherPath(plan.shellPath)).toBe(true)
      expect(plan.shellArgs.join(' ')).toContain('exec "$BASH"')
      // Launcher, exec stub, interactive bash: the shape that a size-1 or size-2 rule never matches.
      await proveIdlePromptCycle(await spawnPlannedPane(plan, env, opts), 3)
    },
    60_000
  )

  it('confirms an idle prompt for an install folder named neither Git nor PortableGit', async () => {
    const discovered = resolveGitBashPath()
    if (!discovered) {
      throw new Error('this host has no Git for Windows install to stage')
    }
    expect(isGitForWindowsBashLauncherPath(discovered)).toBe(true)
    // A junction, not a copy: the operator's install is neither modified nor duplicated.
    const stagingRoot = mkdtempSync(join(tmpdir(), 'orca-git-renamed-'))
    const stagedInstall = join(stagingRoot, 'Git-2.55')
    symlinkSync(dirname(dirname(discovered)), stagedInstall, 'junction')
    const opts: PtySubprocessOptions = {
      sessionId: 'git-bash-renamed-shell-proof',
      cols: 120,
      rows: 30,
      cwd: tmpdir(),
      shellOverride: join(stagedInstall, 'bin', 'bash.exe')
    }
    try {
      const env = createDaemonPtyEnvironment(opts)
      const plan = createPtyShellLaunchPlan(opts, env)
      expect(plan.shellPath).toBe(opts.shellOverride)
      expect(isGitForWindowsBashLauncherPath(plan.shellPath)).toBe(true)
      // No Git Bash startup args for an unrecognized folder, so no exec stub: launcher -> bash.
      await proveIdlePromptCycle(await spawnPlannedPane(plan, env, opts), 2)
    } finally {
      // rmdir, never a recursive remove: it detaches the junction and cannot reach the target.
      rmdirSync(stagedInstall)
      removeTreeSync(stagingRoot)
    }
  }, 60_000)
})
