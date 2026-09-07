import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { resolveGitBashPath } from '../git-bash'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { listPtyJobProcessIds, terminatePtyJob } from './windows-pty-job'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describeOnWindows('MSYS terminal job ownership', () => {
  it('retains and terminates a child across Git Bash shell replacement', async () => {
    const shell = resolveGitBashPath()
    expect(shell, 'Git for Windows must be installed on the native test runner').not.toBeNull()
    const directory = mkdtempSync(join(tmpdir(), 'orca-msys-job-'))
    const script = join(directory, 'owned-child.js')
    writeFileSync(
      script,
      "console.log('MSYS_OWNED_CHILD=' + process.pid); setInterval(() => {}, 1000)\n"
    )
    const pty = await import('node-pty')
    const proc = pty.spawn(shell!, ['-c', 'exec "$BASH" --noprofile --norc -i'], {
      cwd: tmpdir(),
      cols: 120,
      rows: 30,
      useConptyDll: true
    })
    let output = ''
    let childPid: number | undefined
    proc.onData((chunk) => {
      output += chunk
      const match = /MSYS_OWNED_CHILD=(\d+)/.exec(output)
      if (match) {
        childPid = Number(match[1])
      }
    })
    try {
      proc.write(
        `${quotePosixShell(process.execPath.replace(/\\/g, '/'))} ${quotePosixShell(script.replace(/\\/g, '/'))}\r`
      )
      await vi.waitFor(() => expect(childPid).toBeDefined(), { timeout: 15_000 })
      expect(isAlive(childPid!)).toBe(true)
      expect(listPtyJobProcessIds(proc)).toContain(childPid)
      expect(terminatePtyJob(proc)).toBe('terminated')
      await vi.waitFor(() => expect(isAlive(childPid!)).toBe(false), { timeout: 5_000 })
    } finally {
      // The failing baseline can leave this exact fixture child outside the job.
      if (childPid && isAlive(childPid)) {
        process.kill(childPid)
      }
      proc.kill()
      removeTreeSync(directory)
    }
  }, 30_000)
})
