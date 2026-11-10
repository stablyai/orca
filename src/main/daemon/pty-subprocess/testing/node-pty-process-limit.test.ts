import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { TERMINAL_PROCESS_LIMIT_HINT } from '../../../../shared/terminal/pty/lifecycle/terminal-spawn-error-copy'
import { addNodePtyRecoveryHint } from '../node-pty-error-hints'

// #40326: at a process or thread limit (a container's pids.max), starting a PTY's exit watcher
// thread threw a C++ error node-pty does not catch, and the daemon aborted with every terminal.
// RLIMIT_NPROC counts every task (process or thread) of this user. Capping a child at the user's
// current count (which still includes the exiting `ps`) leaves one slot: forkpty takes it and the
// watcher thread finds none. Other tasks of this user make that racy, so the CI "shell contracts"
// job runs this file in its own serial step with ORCA_REQUIRE_PROCESS_LIMIT_PROOF=1; elsewhere it
// is skipped. Root ignores RLIMIT_NPROC, and only Linux counts threads against it.

const REQUIRED = process.env.ORCA_REQUIRE_PROCESS_LIMIT_PROOF === '1'
const WATCHER_REFUSAL = /^node-pty: exit_watcher_thread failed: .*\(errno 11\)/
const FORK_REFUSAL = /^node-pty: forkpty failed: .*\(errno 11\)/

function succeeds(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function canCapTasks(): boolean {
  return (
    process.platform === 'linux' &&
    process.getuid?.() !== 0 &&
    succeeds('prlimit', ['--version']) &&
    succeeds('ps', ['-L', '-p', String(process.pid), '--no-headers'])
  )
}

function isRefusal(value: unknown): value is { spawned: false; message: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'spawned' in value &&
    value.spawned === false &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

/** Every task this user runs right now; RLIMIT_NPROC compares new tasks against this count. */
function userTaskCount(): number {
  const listing = execFileSync('ps', ['-L', '-u', String(process.getuid?.()), '--no-headers'], {
    encoding: 'utf8'
  })
  return listing.split('\n').filter((line) => line.trim().length > 0).length
}

// The child warms libuv's thread pool before any cap, so only the PTY spawn needs a new task.
const CHILD = `
const pty = require(process.argv[1])
const fs = require('node:fs')
const readline = require('node:readline')
fs.readFile('/proc/self/status', () => {
  process.stdout.write('ready\\n')
  readline.createInterface({ input: process.stdin }).on('line', () => {
    let result
    try {
      const term = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24, cwd: '/' })
      term.kill()
      result = { spawned: true }
    } catch (error) {
      result = { spawned: false, message: String(error && error.message) }
    }
    process.stdout.write(JSON.stringify(result) + '\\n')
  })
})
`

describe.skipIf(!REQUIRED)('a PTY spawn at the process limit (Linux)', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  afterEach(() => {
    child?.kill('SIGKILL')
    child = null
  })

  it(
    'fails that spawn with the process-limit hint and keeps the process alive',
    async () => {
      expect(canCapTasks(), 'needs Linux, a non-root user, prlimit and procps ps').toBe(true)
      const ptyPath = createRequire(import.meta.url).resolve('node-pty')
      // The Node binary this node-pty build was made for; vitest itself may run under Bun.
      const node = process.versions.bun ? 'node' : process.execPath
      child = spawn(node, ['-e', CHILD, ptyPath], { stdio: ['pipe', 'pipe', 'pipe'] })
      const running = child
      const lines = createInterface({ input: running.stdout })[Symbol.asyncIterator]()
      const nextLine = async (): Promise<string> => {
        const { value, done } = await lines.next()
        if (done) {
          throw new Error(`child exited (${running.exitCode ?? running.signalCode})`)
        }
        return value
      }
      expect(await nextLine()).toBe('ready')

      const refusals: string[] = []
      // A rising task count refuses the fork instead; keep trying until the watcher thread is refused.
      for (
        let attempt = 0;
        attempt < 40 && !refusals.some((m) => WATCHER_REFUSAL.test(m));
        attempt++
      ) {
        const cap = userTaskCount()
        // Soft limit only: a non-root user cannot raise a lowered hard limit for the next attempt.
        execFileSync('prlimit', ['--pid', String(running.pid), `--nproc=${cap}:`])
        running.stdin.write('spawn\n')
        const result: unknown = JSON.parse(await nextLine())
        if (isRefusal(result)) {
          refusals.push(result.message)
        }
      }

      expect(refusals.some((message) => WATCHER_REFUSAL.test(message))).toBe(true)
      for (const message of refusals) {
        expect(WATCHER_REFUSAL.test(message) || FORK_REFUSAL.test(message)).toBe(true)
        expect(addNodePtyRecoveryHint(message).startsWith(TERMINAL_PROCESS_LIMIT_HINT)).toBe(true)
      }
      // An uncaught native error would have aborted the child before it could answer.
      expect(running.exitCode).toBeNull()
      expect(running.signalCode).toBeNull()
    },
    // Up to 40 spawn rounds, each with a `ps` and a `prlimit`, on a loaded CI runner.
    60_000
  )
})
