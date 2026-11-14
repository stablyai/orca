import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../../../shared/windows-transient-lock-removal'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { confirmPtyShellForeground } from '../pty-shell-foreground-confirmation'
import { createPtyShellLaunchPlan, type PtyShellLaunchPlan } from '../shell-launch-plan'
import { spawnNativeDaemonPty } from '../native-pty-spawn'
import { createDaemonPtyEnvironment } from '../spawn-environment'

import type { PtySubprocessOptions } from '../pty-subprocess'
import { isGitForWindowsBashLauncherPath } from '../../../pty/shell-startup/git-bash'
import { readWindowsPtyJobProcessIds } from '../../../providers/foreground/windows/pty-job-membership'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

async function spawnPlannedPane(
  plan: PtyShellLaunchPlan,
  env: Record<string, string>,
  opts: PtySubprocessOptions
): ReturnType<typeof spawnNativeDaemonPty> {
  return spawnNativeDaemonPty({ ...plan, env, cols: opts.cols, rows: opts.rows })
}

/** Drives a live pane through prompt -> foreground command -> interrupt -> background job. */
async function proveIdlePromptCycle(
  spawned: Awaited<ReturnType<typeof spawnNativeDaemonPty>>,
  expectedJobSize: number
): Promise<void> {
  const proc = spawned.process
  let output = spawned.claimStartupEvents?.().data.join('') ?? ''
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

  it.each([['login shell', {}]])(
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
})
