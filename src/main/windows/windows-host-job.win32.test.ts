import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'

/**
 * The second half of the two-job design.
 *
 * A per-PTY job cannot carry KILL_ON_JOB_CLOSE — its handle is released when
 * the shell exits, which would reap whatever the user had backgrounded. So the
 * host process takes a second job that IS kill-on-close, and children inherit
 * membership. This asserts the property that buys: a host that dies without
 * unwinding strands nothing.
 *
 * It needs a real second process, because the assertion is about what happens
 * when that process is killed. Runs only on win32; skipped elsewhere.
 */
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

// Job-object teardown is external to fake timers; poll the real process table to a deadline.
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true
    }
    await sleep(50)
  }
  return !isAlive(pid)
}

describeOnWindows('host job reaps the tree when the host dies', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-host-job-'))
  })

  afterAll(() => {
    removeTreeSync(dir)
  })

  it('kills a pty and its detached grandchild when the host is force-killed', async () => {
    const nodePtyDir = join(process.cwd(), 'node_modules', 'node-pty')
    const hostScript = join(dir, 'host.js')
    // The host assigns itself, then opens a pty whose shell spawns a DETACHED
    // grandchild — the process a parent-pid walk cannot see.
    writeFileSync(
      hostScript,
      [
        `const pty = require(${JSON.stringify(nodePtyDir)});`,
        `const { loadNativeModule } = require(${JSON.stringify(`${nodePtyDir}/lib/utils`)});`,
        `const native = loadNativeModule('conpty').module;`,
        `console.log('ASSIGNED=' + native.assignCurrentProcessToJob());`,
        `const term = pty.spawn('cmd.exe', [], { name: 'xterm', cols: 80, rows: 30, cwd: ${JSON.stringify(dir)}, useConptyDll: true });`,
        `term.onData((d) => { const m = /GC=(\\d+)/.exec(d); if (m) console.log('GRANDCHILD=' + m[1]); });`,
        `term.write('node -e "const{spawn}=require(\\'child_process\\');const c=spawn(process.execPath,[\\'-e\\',\\'setInterval(()=>{},1000)\\'],{detached:true,windowsHide:true,stdio:\\'ignore\\'});c.unref();console.log(\\'GC=\\'+c.pid);"\\r');`,
        `setTimeout(() => console.log('SHELL=' + term.pid), 4000);`,
        `setInterval(() => {}, 1000);`
      ].join('\n')
    )

    const host = spawn(process.execPath, [hostScript], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    host.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    host.stdout.on('error', () => {})
    host.stderr?.on('error', () => {})

    for (let attempt = 0; attempt < 60 && !/SHELL=/.test(output); attempt += 1) {
      await sleep(250)
    }

    expect(output).toContain('ASSIGNED=true')
    const shellPid = Number(/SHELL=(\d+)/.exec(output)?.[1])
    const grandchildPid = Number(/GRANDCHILD=(\d+)/.exec(output)?.[1])
    expect(Number.isInteger(shellPid)).toBe(true)
    expect(Number.isInteger(grandchildPid)).toBe(true)
    expect(isAlive(grandchildPid)).toBe(true)

    // Force-kill only the host: no tree kill, nothing given a chance to unwind.
    // This is the daemon-crash shape.
    process.kill(host.pid!, 'SIGKILL')
    try {
      const [shellExited, grandchildExited] = await Promise.all([
        waitForProcessExit(shellPid, 15_000),
        waitForProcessExit(grandchildPid, 15_000)
      ])
      expect(shellExited).toBe(true)
      expect(grandchildExited).toBe(true)
    } finally {
      for (const pid of [shellPid, grandchildPid]) {
        try {
          process.kill(pid)
        } catch {
          /* already gone */
        }
      }
    }
  }, 90_000)
})
