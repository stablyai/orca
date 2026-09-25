import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import { confirmPtyShellForeground } from '../daemon/pty-subprocess/pty-shell-foreground-confirmation'
import { createPtyShellLaunchPlan } from '../daemon/pty-subprocess/shell-launch-plan'
import { spawnNativeDaemonPty } from '../daemon/pty-subprocess/native-pty-spawn'
import { createDaemonPtyEnvironment } from '../daemon/pty-subprocess/spawn-environment'
import type { PtySubprocessOptions } from '../daemon/pty-subprocess'
import { isGitForWindowsBashLauncherPath } from '../git-bash'
import { readWindowsPtyJobProcessIds } from './windows-pty-job-membership'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

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
      const spawned = await spawnNativeDaemonPty({ ...plan, env, cols: opts.cols, rows: opts.rows })
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
        // Launcher, exec stub, interactive bash: the shape that a size-1 or size-2 rule never matches.
        await vi.waitFor(() => expect(readWindowsPtyJobProcessIds(proc)?.size).toBe(3), {
          timeout: 5_000
        })
        await vi.waitFor(async () => expect(await confirm()).toBe(true), { timeout: 5_000 })

        proc.write('sleep 60\r')
        await vi.waitFor(async () => expect(await confirm()).toBe(false), { timeout: 10_000 })

        proc.write('\x03')
        await vi.waitFor(async () => expect(await confirm()).toBe(true), { timeout: 10_000 })

        proc.write('sleep 60 &\r')
        await vi.waitFor(async () => expect(await confirm()).toBe(false), { timeout: 10_000 })
      } finally {
        proc.kill()
      }
    },
    60_000
  )
})
