import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { resolveGitBashPath } from '../git-bash'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { listPtyJobProcessIds, terminatePtyJob } from './windows-pty-job'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// `""` keeps the shell's echo of the typed line from matching the marker it prints.
const READY_PROBE = 'echo ORCA_MSYS""_READY\r'
const READY_MARKER = 'ORCA_MSYS_READY'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A ConPTY accepts input before its client has attached and starts reading it,
 * and that input is dropped rather than queued — so a command typed straight
 * after `spawn` sometimes never runs and its marker never arrives.
 *
 * Measured against CI: 40 consecutive healthy `package (windows)` runs
 * (2026-09-22..23) finished this whole test in 3.4-4.1s, so the marker is never
 * merely late; and the same marker-never-arrived shape hits the two cmd.exe
 * siblings under budgets from 4s to 20s, which no single slow runner explains.
 *
 * `echo` is safe to repeat, so probe with that until the shell answers, and only
 * then type the command, which is not safe to repeat.
 */
async function waitUntilShellReadsInput(proc: IPty, readOutput: () => string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!readOutput().includes(READY_MARKER) && Date.now() < deadline) {
    proc.write(READY_PROBE)
    await sleep(500)
  }
  expect(
    readOutput(),
    'Git Bash never echoed the readiness probe, so the pty never accepted input'
  ).toContain(READY_MARKER)
}

describeOnWindows('MSYS terminal job ownership', () => {
  // 60s, not 30s: the readiness handshake and the marker wait each get their own budget.
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
      await waitUntilShellReadsInput(proc, () => output)
      proc.write(
        `${quotePosixShell(process.execPath.replace(/\\/g, '/'))} ${quotePosixShell(script.replace(/\\/g, '/'))}\r`
      )
      // Carry the transcript into the failure: without it a missed marker cannot
      // be told from a child that started and reported something else.
      await vi.waitFor(
        () =>
          expect(
            childPid,
            `no child pid in the pty transcript: ${JSON.stringify(output.slice(-2_000))}`
          ).toBeDefined(),
        { timeout: 15_000 }
      )
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
  }, 60_000)
})
