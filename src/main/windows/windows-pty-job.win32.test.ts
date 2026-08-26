import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPty } from 'node-pty'
import {
  isPtyJobOwnershipAvailable,
  listPtyJobProcessIds,
  terminatePtyJob
} from './windows-pty-job'

/**
 * The unit tests pin the contract; this pins the thing the contract is for.
 *
 * A grandchild spawned `detached` leaves the pane's console and reparents, so
 * neither `GetConsoleProcessList` nor a parent-pid walk can see it. That is the
 * process that outlived its pane and held the worktree directory open
 * (#9045, #10475, #10897). Job membership is the only mechanism that finds it,
 * so the assertion below is the whole justification for the node-pty patch.
 *
 * Runs only on win32; skipped elsewhere.
 */
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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

  async function spawnShellWithDetachedGrandchild(): Promise<{
    proc: IPty
    grandchildPid: number
  }> {
    const nodePty = await import('node-pty')
    const proc = nodePty.spawn('cmd.exe', [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: process.cwd(),
      useConptyDll: true
    })
    spawned.push(proc)

    let grandchildPid: number | null = null
    proc.onData((chunk) => {
      const match = /ORCA_GC=(\d+)/.exec(chunk)
      if (match && grandchildPid === null) {
        grandchildPid = Number(match[1])
      }
    })

    const script = [
      "const{spawn}=require('child_process');",
      "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],",
      "{detached:true,stdio:'ignore'});",
      "c.unref();console.log('ORCA_GC='+c.pid);"
    ].join('')
    proc.write(`node -e "${script}"\r`)

    for (let attempt = 0; attempt < 80 && grandchildPid === null; attempt += 1) {
      await sleep(250)
    }
    if (grandchildPid === null) {
      throw new Error('grandchild never reported its pid')
    }
    // Let the shell settle so the pid list is not read mid-spawn.
    await sleep(1_000)
    return { proc, grandchildPid }
  }

  it('reports this build as able to own pty trees', () => {
    // A node-pty rebuilt from unpatched sources would silently fall back to the
    // old probe, so every assertion below would pass vacuously.
    expect(isPtyJobOwnershipAvailable()).toBe(true)
  })

  it('counts a detached grandchild as part of the pane tree', async () => {
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()

    const pids = listPtyJobProcessIds(proc)
    expect(pids).not.toBeNull()
    expect(pids).toContain(proc.pid)
    expect(pids).toContain(grandchildPid)
  }, 60_000)

  it('kills the shell and the detached grandchild in one call', async () => {
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()
    expect(isAlive(grandchildPid)).toBe(true)

    expect(terminatePtyJob(proc)).toBe('terminated')
    await sleep(1_500)

    expect(isAlive(proc.pid)).toBe(false)
    expect(isAlive(grandchildPid)).toBe(false)
  }, 60_000)

  it('leaves a backgrounded process alone when the shell exits cleanly', async () => {
    // The job must make an EXPLICIT teardown exact without redefining what a
    // clean exit means. Measured: with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set,
    // typing `exit` reaped a detached server that survived before the patch --
    // a behaviour change nobody asked for. This pins the absence of that flag.
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()

    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()))
    proc.write('exit\r')
    await exited
    await sleep(2_000)

    expect(isAlive(grandchildPid)).toBe(true)
    try {
      process.kill(grandchildPid)
    } catch {
      /* already gone */
    }
  }, 60_000)

  it('still starts a backgrounded child from inside the job', async () => {
    // Scope note: `start /b` uses CREATE_NEW_CONSOLE, not
    // CREATE_BREAKAWAY_FROM_JOB, so this does NOT prove the BREAKAWAY_OK flag
    // is doing its job -- it proves job membership does not block ordinary
    // backgrounding. The flag itself rests on the Win32 contract (a job lacking
    // JOB_OBJECT_LIMIT_BREAKAWAY_OK denies breakaway with ERROR_ACCESS_DENIED
    // regardless of its other limits) and is not covered by a test here.
    // Covering it needs a helper that passes the flag to CreateProcess.
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
    rmSync(marker, { force: true })
  }, 60_000)

  it('stops answering once the tree is gone, rather than claiming it is empty', async () => {
    // Measured, not assumed: node-pty drops its handle record and closes the
    // job when the shell exits, so a dead tree is unverifiable here rather than
    // observably empty. Callers must not read null as proof of death -- the
    // verdict vocabulary in docs/reference/ssh-execution-boundary.md applies.
    const { proc } = await spawnShellWithDetachedGrandchild()
    terminatePtyJob(proc)
    await sleep(1_500)

    expect(listPtyJobProcessIds(proc)).toBeNull()
  }, 60_000)
})
