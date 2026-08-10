import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitPush } from './remote'

const EXPECTED_OUTCOME = process.env.ORCA_GIT_TIMEOUT_ORACLE_EXPECT ?? 'timeout'
const EXPECTED_TIMEOUT_MESSAGE =
  'Push timed out. Check your network connection and Git authentication, then try again.'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (check()) {
      return
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for real Git process state')
}

function processIsRunning(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8'
    }).trim()
    return state.length > 0 && !state.startsWith('Z')
  } catch {
    return false
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The candidate should already have reaped the process tree.
  }
}

function windowsProcessIsRunning(pid: number): boolean {
  try {
    const output = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
      encoding: 'utf8'
    })
    return output.includes(`"${pid}"`)
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('real remote Git timeout oracle', () => {
  let root = ''
  let hookPid = 0
  let helperPid = 0

  afterEach(() => {
    vi.useRealTimers()
    killIfAlive(helperPid)
    killIfAlive(hookPid)
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bounds a blocking push and removes its hook tree', async () => {
    expect(['pending', 'timeout']).toContain(EXPECTED_OUTCOME)
    root = mkdtempSync(join(tmpdir(), 'orca-real-git-timeout-'))
    const remote = join(root, 'remote.git')
    const worktree = join(root, 'worktree')
    const marker = join(root, 'hook-pids')

    git(root, ['init', '--bare', remote])
    git(root, ['init', worktree])
    git(worktree, ['config', 'user.name', 'Orca Test'])
    git(worktree, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(worktree, 'file.txt'), 'initial\n')
    git(worktree, ['add', 'file.txt'])
    git(worktree, ['commit', '-m', 'initial'])
    git(worktree, ['remote', 'add', 'origin', remote])
    git(worktree, ['push', '--set-upstream', 'origin', 'HEAD:main'])

    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      `#!/bin/sh\ntrap '' TERM HUP INT\nsleep 600 &\nchild=$!\nprintf '%s %s\\n' "$$" "$child" > ${shellQuote(marker)}\nwait "$child"\n`
    )
    chmodSync(hook, 0o755)
    writeFileSync(join(worktree, 'file.txt'), 'next\n')
    git(worktree, ['add', 'file.txt'])
    git(worktree, ['commit', '-m', 'next'])

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    let observed = 'pending'
    const operation = gitPush(worktree, false, undefined, { signal: controller.signal }).then(
      () => {
        observed = 'resolved'
      },
      (error: unknown) => {
        observed = error instanceof Error ? error.message : String(error)
      }
    )

    let markerPids: number[] = []
    await waitFor(() => {
      try {
        markerPids = readFileSync(marker, 'utf8').trim().split(' ').map(Number)
        return markerPids.length === 2 && markerPids.every(Number.isSafeInteger)
      } catch {
        return false
      }
    })
    ;[hookPid, helperPid] = markerPids

    await vi.advanceTimersByTimeAsync(120_000)
    await new Promise<void>((resolve) => setImmediate(resolve))

    if (EXPECTED_OUTCOME === 'timeout') {
      expect(observed).toBe(EXPECTED_TIMEOUT_MESSAGE)
      await vi.advanceTimersByTimeAsync(2_000)
      await waitFor(() => !processIsRunning(hookPid) && !processIsRunning(helperPid))
    } else {
      expect(observed).toBe('pending')
      controller.abort()
      killIfAlive(helperPid)
      killIfAlive(hookPid)
      await waitFor(() => observed !== 'pending')
    }

    await operation
    console.info(`real-git-timeout-oracle=${EXPECTED_OUTCOME}:${observed}`)
  })
})

describe.skipIf(process.platform !== 'win32')('real Windows remote Git cleanup', () => {
  let root = ''
  let helperPid = 0

  afterEach(() => {
    if (helperPid > 0 && windowsProcessIsRunning(helperPid)) {
      try {
        execFileSync('taskkill', ['/pid', String(helperPid), '/t', '/f'], { stdio: 'ignore' })
      } catch {
        // The candidate should already have reaped the process tree.
      }
    }
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reaps the hook tree before returning a maxBuffer error', { timeout: 30_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-real-git-max-buffer-'))
    const remote = join(root, 'remote.git')
    const worktree = join(root, 'worktree')
    const marker = join(remote, 'hook-helper-pid')

    git(root, ['init', '--bare', remote])
    git(root, ['init', worktree])
    git(worktree, ['config', 'user.name', 'Orca Test'])
    git(worktree, ['config', 'user.email', 'orca-test@example.com'])
    writeFileSync(join(worktree, 'file.txt'), 'initial\n')
    git(worktree, ['add', 'file.txt'])
    git(worktree, ['commit', '-m', 'initial'])
    git(worktree, ['remote', 'add', 'origin', remote])
    git(worktree, ['push', '--set-upstream', 'origin', 'HEAD:main'])

    const hook = join(remote, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      `#!/bin/sh\npowershell.exe -NoProfile -NonInteractive -Command '$PID | Set-Content -Encoding ascii -LiteralPath "hook-helper-pid"; while ($true) { [Console]::Error.Write(("x" * 65536)); [Console]::Error.Flush() }'\n`
    )
    chmodSync(hook, 0o755)
    writeFileSync(join(worktree, 'file.txt'), 'next\n')
    git(worktree, ['add', 'file.txt'])
    git(worktree, ['commit', '-m', 'next'])

    const operation = gitPush(worktree)
    await waitFor(() => {
      try {
        helperPid = Number(readFileSync(marker, 'utf8').trim())
        return Number.isSafeInteger(helperPid) && helperPid > 0
      } catch {
        return false
      }
    })

    await expect(operation).rejects.toThrow(/maxBuffer/i)
    await waitFor(() => !windowsProcessIsRunning(helperPid))
  })
})
