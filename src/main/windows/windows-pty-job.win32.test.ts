import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import { runProcess } from '@orca/process-host'
import { killConptyNow } from './windows-pty-job'
import { watchConptyStartup } from '../daemon/pty-subprocess/conpty-startup-input-reader'

/** Real Windows jobs must find detached/reparented grandchildren that console/PID walks miss (#9045/#10475/#10897). */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // An inaccessible process is still alive; only a missing pid proves exit.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Teardown is asynchronous; poll instead of guessing how long the job takes.
async function waitUntilDead(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) {
    await sleep(50)
  }
}

describeOnWindows('ConPTY job ownership', () => {
  const spawned: IPty[] = []

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
  })

  // Allow a real ConPTY host to publish its startup query on slow Windows CI.
  it('announces an input reader the daemon recognizes', async () => {
    // A ConPTY upgrade that changes its startup must fail here, not respawn every pane.
    const nodePty = await import('node-pty')
    const proc = nodePty.spawn('cmd.exe', ['/d', '/q'], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      useConptyDll: true
    })
    spawned.push(proc)
    const startup = watchConptyStartup(proc)
    expect(await startup.verdict).toBe('input-reader')
    startup.claim()
  }, 30_000)

  // Allow native ConPTY teardown to settle before observing process retirement.
  it('tears down a pane discarded before its first output', async () => {
    // node-pty's own kill() would wait for output that a discarded pane never sends.
    const nodePty = await import('node-pty')
    const proc = nodePty.spawn('cmd.exe', ['/d', '/q'], {
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      useConptyDll: true
    })
    spawned.push(proc)
    killConptyNow(proc)
    await waitUntilDead(proc.pid)
    expect(isAlive(proc.pid)).toBe(false)
  }, 30_000)

  it('keeps the native table intact while shell cleanup overlaps new terminals', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: [
        join(
          process.cwd(),
          'config',
          'scripts',
          'diagnostics',
          'windows-pty',
          'windows-pty-table-stress.cjs'
        )
      ],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 90_000
    })
    const status = result.code === null ? 'null' : `0x${(result.code >>> 0).toString(16)}`
    if (result.code === 0 && !result.timedOut) {
      console.log(result.stdout)
    }
    expect(
      result,
      `Native host exited ${status} (${result.signal}); timedOut=${result.timedOut}\n${result.stdout}\n${result.stderr}`
    ).toMatchObject({ code: 0, timedOut: false })
    expect(result.stdout).toContain('"phase":"complete"')
  }, 100_000)

  it('still starts a backgrounded child from inside the job', async () => {
    // start /b proves ordinary backgrounding, not CREATE_BREAKAWAY_FROM_JOB rejection; that flag needs a dedicated native helper.
    const nodePty = await import('node-pty')
    const marker = join(mkdtempSync(join(tmpdir(), 'orca-breakaway-')), 'marker.txt')
    const proc = nodePty.spawn('cmd.exe', [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: tmpdir(),
      useConptyDll: true
    })
    spawned.push(proc)

    let output = ''
    proc.onData((chunk) => {
      output += chunk
    })
    proc.write(`start /b cmd /c "echo ORCA_BREAKAWAY> ${marker}"\r`)

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 15_000 })
    expect(output).not.toMatch(/Access is denied/i)
    await vi.waitFor(() => rmSync(marker, { force: true }))
  }, 60_000)
})
