import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync, readlinkSync, renameSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { getNodePtySpawnHelperCandidates } from '../providers/local-pty-utils'

function currentRevokedFdCount(): number {
  return execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes('(revoked)')).length
}

function currentOpenFdCount(): number {
  return execFileSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

function getExistingSpawnHelper(): string {
  const helperPath = getNodePtySpawnHelperCandidates().find((candidate) => existsSync(candidate))
  expect(helperPath).toBeTruthy()
  return helperPath as string
}

async function spawnExitingPty(index: number): Promise<void> {
  const proc = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env, ORCA_FD_LEAK_TEST_INDEX: String(index) }
  })

  await new Promise<void>((resolve) => {
    proc.onExit(() => resolve())
  })
  ;(proc as unknown as { destroy?: () => void }).destroy?.()
}

const describeOnDarwin = process.platform === 'darwin' ? describe : describe.skip

describeOnDarwin('node-pty macOS spawn fd handling', () => {
  it('does not leak revoked slave tty fds across exited pty spawns', async () => {
    const before = currentRevokedFdCount()

    for (let i = 0; i < 50; i++) {
      await spawnExitingPty(i)
    }

    await delay(500)
    const after = currentRevokedFdCount()

    expect(after - before).toBe(0)
  }, 15000)

  it('does not leak fds when native posix_spawn setup fails', async () => {
    const helperPath = getExistingSpawnHelper()
    const hiddenHelperPath = `${helperPath}.orca-test-hidden`
    expect(existsSync(hiddenHelperPath)).toBe(false)

    const before = currentOpenFdCount()
    renameSync(helperPath, hiddenHelperPath)
    const restoreHelper = (): void => {
      if (existsSync(hiddenHelperPath) && !existsSync(helperPath)) {
        renameSync(hiddenHelperPath, helperPath)
      }
    }
    process.on('exit', restoreHelper)
    try {
      for (let i = 0; i < 20; i++) {
        expect(() =>
          pty.spawn('/bin/sh', ['-c', 'exit 0'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: { ...process.env, ORCA_FD_LEAK_TEST_INDEX: String(i) }
          })
        ).toThrow(/node-pty: posix_spawn failed: ENOENT/)
      }
    } finally {
      restoreHelper()
      process.off('exit', restoreHelper)
    }

    await delay(500)
    const after = currentOpenFdCount()

    expect(after - before).toBe(0)
  }, 15000)
})

// Linux is the only platform where node-pty takes the forkpty() path, which has no atomic
// O_CLOEXEC. /proc is what makes the inheritance observable, so the assertions live here.
const describeOnLinux = process.platform === 'linux' ? describe : describe.skip

const O_CLOEXEC = 0o2000000

const LISTING_READY = '__fd_listing_ready__'

function ptyMasterFd(term: pty.IPty): number {
  return (term as unknown as { fd: number }).fd
}

function isCloseOnExec(fd: number): boolean {
  const flags = /flags:\s*(\d+)/.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
  expect(flags).toBeTruthy()
  return (Number.parseInt(flags![1]!, 8) & O_CLOEXEC) !== 0
}

function openFdTargets(pid: number): string[] {
  return readdirSync(`/proc/${pid}/fd`).map((entry) => {
    try {
      return readlinkSync(`/proc/${pid}/fd/${entry}`)
    } catch {
      return ''
    }
  })
}

describeOnLinux('node-pty Linux forkpty fd handling', () => {
  it('marks pty masters close-on-exec so later children cannot inherit them', async () => {
    const terms: pty.IPty[] = []
    let child: ReturnType<typeof spawn> | null = null
    try {
      for (let i = 0; i < 3; i++) {
        terms.push(
          pty.spawn('/bin/sh', ['-c', 'sleep 30'], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: { ...process.env, ORCA_FD_LEAK_TEST_INDEX: String(i) }
          })
        )
      }

      // The masters this process owns must not survive an exec in any child it forks later.
      expect(terms.map((term) => isCloseOnExec(ptyMasterFd(term)))).toEqual([true, true, true])

      child = spawn('/bin/sh', ['-c', 'sleep 5'], { stdio: 'ignore' })
      await once(child, 'spawn')
      const inherited = openFdTargets(child.pid!).filter((target) => target.includes('ptmx'))
      expect(inherited).toEqual([])
    } finally {
      child?.kill()
      for (const term of terms) {
        term.kill()
      }
    }
  }, 15000)

  it('does not hand an earlier pty master to a later pty child', async () => {
    const first = pty.spawn('/bin/sh', ['-c', 'sleep 30'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env }
    })
    try {
      // Why the read: the child must not be able to run its listing before onData is armed, or an
      // empty capture would satisfy the negative assertion without inspecting a single fd.
      const second = pty.spawn(
        '/bin/sh',
        ['-c', `IFS= read -r _; printf '${LISTING_READY}\\n'; ls -l /proc/self/fd; exit 0`],
        {
          name: 'xterm-256color',
          cols: 200,
          rows: 24,
          cwd: process.cwd(),
          env: { ...process.env }
        }
      )
      let output = ''
      second.onData((data) => {
        output += data
      })
      second.write('go\n')
      await new Promise<void>((resolve) => {
        second.onExit(() => resolve())
      })
      await delay(100)

      // The listing is the evidence; assert it arrived before reading anything into its absence.
      expect(output).toContain(LISTING_READY)
      expect(output).toMatch(/\d+ -> \/dev\/pts\//)
      expect(output).not.toMatch(/ptmx/)
    } finally {
      first.kill()
    }
  }, 15000)
})
