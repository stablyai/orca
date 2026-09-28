import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import { confirmPtyShellForeground } from '../daemon/pty-subprocess/pty-shell-foreground-confirmation'
import { createPtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'
import { spawnNativeDaemonPty } from '../daemon/pty-subprocess/native-pty-spawn'
import { canUseBunPty, spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import { createWindowsBunPtyLaunch } from '../daemon/pty-subprocess/windows-bun-pty-launch'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import type { PtySubprocessOptions } from '../daemon/pty-subprocess'
import { isGitForWindowsBashLauncherPath } from '../git-bash'
import { readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

async function waitForAssertion(check: () => unknown, options: { timeout: number }): Promise<void> {
  const deadline = Date.now() + options.timeout
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
      await delay(50)
    }
  }
}

export async function verifyGitBashForeground(extraEnv: Record<string, string>): Promise<void> {
  assert.equal(process.platform, 'win32')
  assert(process.versions.bun)
  const previousUserData = process.env.ORCA_USER_DATA_PATH
  const userData = mkdtempSync(join(tmpdir(), 'orca-git-bash-proof-'))
  process.env.ORCA_USER_DATA_PATH = userData
  try {
    const opts: PtySubprocessOptions = {
      sessionId: 'git-bash-shell-proof',
      cols: 120,
      rows: 30,
      cwd: tmpdir(),
      shellOverride: WINDOWS_GIT_BASH_SHELL,
      env: extraEnv
    }
    const env = createDaemonPtyEnvironment(opts)
    const plan = await createPtyShellLaunchPlan(opts, env)
    assert(isGitForWindowsBashLauncherPath(plan.shellPath))
    assert(plan.shellArgs.join(' ').includes('exec "$BASH"'))
    const spawned = await spawnNativeDaemonPty(
      { ...plan, env, cols: opts.cols, rows: opts.rows },
      {
        canUseBunPty,
        spawnBunPty: (args) =>
          spawnBunPty(args, {
            // Source tests use the TS worker; packaged hosts resolve their adjacent JS worker.
            createWindowsLaunch: (launch) =>
              createWindowsBunPtyLaunch(launch, {
                workerPath: join(
                  __dirname,
                  '../daemon/pty-subprocess/windows-bun-pty-gate-entry.ts'
                )
              })
          })
      }
    )
    const proc = spawned.process
    let output = ''
    let dead = false
    proc.onData((chunk) => {
      output += chunk
    })
    const exited = new Promise<void>((resolve) => {
      proc.onExit(() => {
        dead = true
        resolve()
      })
    })
    const confirm = (): Promise<boolean> =>
      confirmPtyShellForeground({
        process: proc,
        shellPath: spawned.shellPath,
        isDead: () => dead
      })
    try {
      await waitForAssertion(() => assert(output.includes('$')), { timeout: 20_000 })
      // Launcher, exec stub, interactive bash: the shape that a size-1 or size-2 rule never matches.
      await waitForAssertion(() => assert.equal(readWindowsPtyJobProcessIds(proc)?.size, 3), {
        timeout: 5_000
      })
      await waitForAssertion(async () => assert.equal(await confirm(), true, 'initial prompt'), {
        timeout: 5_000
      })

      // Interrupt only after the child is ready, not during a transient shell fork.
      proc.write(
        "node -e \"console.log(['ORCA','FOREGROUND_READY'].join('_')); setInterval(() => {}, 1000)\"\r"
      )
      await waitForAssertion(() => assert(output.includes('ORCA_FOREGROUND_READY')), {
        timeout: 10_000
      })
      await waitForAssertion(async () => assert.equal(await confirm(), false), { timeout: 10_000 })

      proc.write('\x03')
      await waitForAssertion(
        async () => {
          assert.equal(dead, false, 'terminal survived foreground interrupt')
          assert.equal(await confirm(), true, 'prompt after interrupt')
        },
        { timeout: 10_000 }
      )

      proc.write('sleep 60 &\r')
      await waitForAssertion(async () => assert.equal(await confirm(), false), { timeout: 10_000 })
    } finally {
      proc.kill()
      await Promise.race([
        exited,
        delay(5_000, undefined, { ref: false }).then(() => {
          throw new Error('Git Bash fixture did not exit')
        })
      ])
    }
  } finally {
    if (previousUserData === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserData
    }
    removeTreeSync(userData)
  }
}
