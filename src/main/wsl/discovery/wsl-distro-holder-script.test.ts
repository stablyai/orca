import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ORCAD_WSL_HOLDER_BLOCKED_FILENAME,
  ORCAD_WSL_HOLDER_RELEASE_FILENAME
} from '../../../shared/orcad-idle-exit'
import { buildWslDistroHolderScript, WSL_DISTRO_HOLDER_MARKER } from './wsl-distro-holder-command'

// The script runs inside the distro; any POSIX sh here exercises the same text. A fake /proc stands
// in for the distro's, so the test runner's own processes never count as the user's work.
let home: string
let proc: string
let children: ChildProcess[]
const me = userInfo().uid

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-holder-script-'))
  mkdirSync(join(home, '.orca'))
  proc = join(home, 'proc')
  mkdirSync(proc)
  children = []
})

afterEach(() => {
  for (const child of children) {
    child.kill('SIGKILL')
  }
  rmSync(home, { recursive: true, force: true })
})

function track(child: ChildProcess): ChildProcess {
  children.push(child)
  return child
}

function startHolder(
  env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH },
  options: { procReadable?: boolean } = {}
) {
  const child = track(
    spawn(
      '/bin/sh',
      ['-c', buildWslDistroHolderScript(POLL_SECONDS, proc), WSL_DISTRO_HOLDER_MARKER],
      {
        env,
        stdio: 'ignore'
      }
    )
  )
  // A real /proc always shows the holder itself; without that entry the scan fails closed.
  if (options.procReadable !== false && child.pid !== undefined) {
    fakeProcess(child.pid, { name: 'sh', ppid: 1 })
  }
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  return { child, exited }
}

function within(ms: number, promise: Promise<number | null>): Promise<number | null | 'running'> {
  return Promise.race([
    promise,
    // ast-grep-ignore: test-no-real-time-wait -- a real shell must still be holding after this long
    new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), ms))
  ])
}

/** Waits that end when the holder exits; generous so a loaded machine cannot fail them. */
const RELEASE_BOUND_MS = 15_000
/** A short poll keeps the suite fast; the holder's script is otherwise the production text. */
const POLL_SECONDS = 0.1
/** Several polls: a holder that would let go has done so by then. */
const HOLDING_MS = 500

/** The holder found the request and now waits out the requesting orcad (its `sleep 1` loop). */
function waitingOnOrcad(holder: ChildProcess): boolean {
  return spawnSync('pgrep', ['-P', String(holder.pid), '-f', '^sleep 1$']).status === 0
}

const releasePath = (): string => join(home, '.orca', ORCAD_WSL_HOLDER_RELEASE_FILENAME)

/** One fake /proc entry, as the kernel writes its status file. */
function fakeProcess(
  pid: number,
  fields: { name?: string; state?: string; ppid?: number; uid?: number } = {}
): string {
  const dir = join(proc, String(pid))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'status'),
    `Name:\t${fields.name ?? 'tmux: server'}\nState:\t${fields.state ?? 'S (sleeping)'}\n` +
      `PPid:\t${fields.ppid ?? 1}\nUid:\t${fields.uid ?? me}\t${fields.uid ?? me}\t0\t0\n`
  )
  return dir
}

const blockedPath = (): string => join(home, '.orca', ORCAD_WSL_HOLDER_BLOCKED_FILENAME)

const readBlocked = (): string =>
  existsSync(blockedPath()) ? readFileSync(blockedPath(), 'utf8') : ''

/**
 * A holder past its start-up cleanup: it clears stale notes as it starts, so once this sentinel is
 * gone its `rm -f` of the request is done and a request written next survives (a timed wait
 * raced it on a loaded machine).
 */
async function startHolderReady(
  env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH },
  options: { procReadable?: boolean } = {}
) {
  const started = `${blockedPath()}.started`
  writeFileSync(started, '')
  const holder = startHolder(env, options)
  await expect.poll(() => existsSync(started), { timeout: 15_000 }).toBe(false)
  return holder
}

/** A holder past its start-up cleanup, then a request from an orcad that has exited. */
async function holderWithRequest(options: { procReadable?: boolean; path?: string } = {}) {
  const holder = await startHolderReady(
    { HOME: home, PATH: options.path ?? process.env.PATH },
    options
  )
  const orcad = track(spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }))
  await new Promise((resolve) => orcad.once('exit', resolve))
  writeFileSync(releasePath(), `${orcad.pid}\n`)
  return holder
}

describe.skipIf(process.platform === 'win32')('WSL distro holder script', () => {
  it('waits for the requesting orcad to exit, then claims the request and ends', async () => {
    const holder = await startHolderReady()
    const orcad = track(spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' }))
    writeFileSync(releasePath(), `${orcad.pid}\n`)

    await expect.poll(() => waitingOnOrcad(holder.child), { timeout: 15_000 }).toBe(true)
    expect(await within(HOLDING_MS, holder.exited)).toBe('running')
    orcad.kill('SIGKILL')
    expect(await within(RELEASE_BOUND_MS, holder.exited)).toBe(0)
    expect(existsSync(releasePath())).toBe(false)
  })

  it('keeps holding when a starting orcad withdrew the request first', async () => {
    const holder = await startHolderReady()
    const orcad = track(spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' }))
    writeFileSync(releasePath(), `${orcad.pid}\n`)
    await expect.poll(() => waitingOnOrcad(holder.child), { timeout: 15_000 }).toBe(true)
    rmSync(releasePath())
    orcad.kill('SIGKILL')
    // Its `sleep 1` ends within a second of the kill; then it finds the request gone.
    expect(await within(1_000 + HOLDING_MS, holder.exited)).toBe('running')
  })

  it('keeps the distro while the user still runs something, and lets go once it ends', async () => {
    // e.g. a detached tmux server or a nohup'd job started from an Orca terminal.
    const job = fakeProcess(4242)
    const { exited } = await holderWithRequest()
    // Its note says it decided to hold.
    await expect.poll(readBlocked, { timeout: 15_000 }).not.toBe('')
    expect(await within(HOLDING_MS, exited)).toBe('running')
    expect(existsSync(releasePath())).toBe(true)
    rmSync(job, { recursive: true })
    expect(await within(RELEASE_BOUND_MS, exited)).toBe(0)
  })

  it('keeps the distro while a container runs, though its shim belongs to root', async () => {
    const shim = fakeProcess(4343, { name: 'containerd-shim-runc-v2', uid: 0 })
    // dockerd itself, idle and root-owned, is a system service, not work.
    fakeProcess(4344, { name: 'dockerd', uid: 0 })
    const { exited } = await holderWithRequest()
    await expect.poll(readBlocked, { timeout: 15_000 }).toBe('containerd-shim-runc-v2\n')
    expect(await within(HOLDING_MS, exited)).toBe('running')
    rmSync(shim, { recursive: true })
    expect(await within(RELEASE_BOUND_MS, exited)).toBe(0)
  })

  it('fails closed when /proc cannot be read', async () => {
    const { exited } = await holderWithRequest({ procReadable: false })
    await expect.poll(readBlocked, { timeout: 15_000 }).toBe('proc-unreadable\n')
    expect(await within(HOLDING_MS, exited)).toBe('running')
  })

  it('fails closed on a status file it cannot parse', async () => {
    const dir = join(proc, '7000')
    mkdirSync(dir)
    writeFileSync(join(dir, 'status'), 'Name:\tmystery\n')
    const { exited } = await holderWithRequest()
    await expect.poll(readBlocked, { timeout: 15_000 }).toBe('mystery\n')
    expect(await within(HOLDING_MS, exited)).toBe('running')
  })

  it("counts an unreadable entry only when it is the user's own (hidepid=noaccess)", async () => {
    // Root's status files are unreadable under hidepid; their directories still show their owner.
    const dir = join(proc, '7100')
    mkdirSync(dir)
    writeFileSync(join(dir, 'status'), 'Name:\tsecret\n')
    chmodSync(join(dir, 'status'), 0o000)
    // The user's own unreadable entry holds: wait for the holder's own note that it decided so,
    // not for a clock, so a loaded machine cannot make this flaky.
    const own = await holderWithRequest()
    await expect.poll(readBlocked, { timeout: 15_000 }).not.toBe('')
    // Holding means the request stays unclaimed.
    expect(existsSync(releasePath())).toBe(true)
    own.child.kill('SIGKILL')
    await own.exited
    // Seen by another user, the same entry is someone else's and does not hold.
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'id'), `#!/bin/sh\necho ${me + 1}\n`, { mode: 0o755 })
    const other = await holderWithRequest({ path: `${bin}:${process.env.PATH}` })
    expect(await within(RELEASE_BOUND_MS, other.exited)).toBe(0)
  })
})
