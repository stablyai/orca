import { createWindowsBunPtyLaunch } from '../daemon/pty-subprocess/windows-bun-pty-launch'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canUseBunPty, spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'
import type { BunPtyProcess } from '../daemon/pty-subprocess/bun-pty-process-contract'
import { runProcess } from '../../shared/child-process/run-process'
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
 * so the assertion below is the reason this runtime must retain exact job ownership.
 *
 * Runs only on win32; skipped elsewhere.
 */
const spawnTestPty: typeof spawnBunPty = (args) =>
  spawnBunPty(args, {
    createWindowsLaunch: (launch) =>
      createWindowsBunPtyLaunch(launch, {
        workerPath: join(__dirname, '../daemon/pty-subprocess/windows-bun-pty-gate-entry.ts')
      })
  })

const describeOnWindows = process.platform === 'win32' && canUseBunPty() ? describe : describe.skip

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
  const spawned: BunPtyProcess[] = []

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
    proc: BunPtyProcess
    grandchildPid: number
  }> {
    const proc = spawnTestPty({
      file: process.env.ComSpec || 'cmd.exe',
      args: [],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      cols: 80,
      rows: 30,
      cwd: process.cwd()
    })
    spawned.push(proc)
    await proc.waitForSpawn?.()

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
      "{detached:true,windowsHide:true,stdio:'ignore'});",
      "c.unref();console.log('ORCA_GC='+c.pid);"
    ].join('')
    proc.write(`"${process.execPath}" -e "${script}"\r`)

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
    expect(isPtyJobOwnershipAvailable()).toBe(true)
  })

  it('keeps the native table intact while shell cleanup overlaps new terminals', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: [join(process.cwd(), 'config', 'scripts', 'windows-pty-table-stress.mjs')],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 90_000
    })
    const status = result.code === null ? 'null' : `0x${(result.code >>> 0).toString(16)}`
    expect(
      result,
      `Native host exited ${status} (${result.signal}); timedOut=${result.timedOut}\n${result.stdout}\n${result.stderr}`
    ).toMatchObject({ code: 0, timedOut: false })
    expect(result.stdout).toContain('"phase":"complete"')
  }, 100_000)

  it('counts a detached grandchild as part of the pane tree', async () => {
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()

    const pids = listPtyJobProcessIds(proc)
    expect(pids).not.toBeNull()
    expect(pids).toContain(proc.shellProcessId)
    expect(pids).toContain(grandchildPid)
  }, 60_000)

  it('kills the shell and the detached grandchild in one call', async () => {
    const { proc, grandchildPid } = await spawnShellWithDetachedGrandchild()
    expect(isAlive(grandchildPid)).toBe(true)

    expect(terminatePtyJob(proc)).toBe('terminated')
    await waitUntilDead(proc.pid)
    await waitUntilDead(grandchildPid)

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
    // Denying explicit breakaway must still permit ordinary background commands.
    const marker = join(mkdtempSync(join(tmpdir(), 'orca-breakaway-')), 'marker.txt')
    const proc = spawnTestPty({
      file: process.env.ComSpec || 'cmd.exe',
      args: [],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      cols: 100,
      rows: 30,
      cwd: tmpdir()
    })
    spawned.push(proc)
    await proc.waitForSpawn?.()

    let output = ''
    proc.onData((chunk) => {
      output += chunk
    })
    proc.write(`start /b cmd /c "echo ORCA_BREAKAWAY> ${marker}"\r`)

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 15_000 })
    expect(output).not.toMatch(/Access is denied/i)
    await vi.waitFor(() => rmSync(marker, { force: true }))
  }, 60_000)

  it('stops answering once the tree is gone, rather than claiming it is empty', async () => {
    // The adapter closes its handle record and the
    // job when the shell exits, so a dead tree is unverifiable here rather than
    // observably empty. Callers must not read null as proof of death -- the
    // verdict vocabulary in docs/reference/ssh-execution-boundary.md applies.
    const { proc } = await spawnShellWithDetachedGrandchild()
    terminatePtyJob(proc)
    await sleep(1_500)

    expect(listPtyJobProcessIds(proc)).toBeNull()
  }, 60_000)
})
