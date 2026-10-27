import { spawn, type ChildProcess } from 'node:child_process'
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
} from '../../shared/orcad-idle-exit'
import {
  buildWslDistroHolderScript,
  WSL_DISTRO_HOLDER_BLOCKED_NAMES_MAX,
  WSL_DISTRO_HOLDER_IGNORED_PROCESS_NAMES,
  WSL_DISTRO_HOLDER_MARKER
} from './wsl-distro-holder-command'

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
    spawn('/bin/sh', ['-c', buildWslDistroHolderScript(1, proc), WSL_DISTRO_HOLDER_MARKER], {
      env,
      stdio: 'ignore'
    })
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

/** A holder that already ran its start-up `rm -f`, then a request from an orcad that has exited. */
async function holderWithRequest(options: { procReadable?: boolean; path?: string } = {}) {
  const holder = startHolder({ HOME: home, PATH: options.path ?? process.env.PATH }, options)
  expect(await within(300, holder.exited)).toBe('running')
  const orcad = track(spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }))
  await new Promise((resolve) => orcad.once('exit', resolve))
  writeFileSync(releasePath(), `${orcad.pid}\n`)
  return holder
}

describe.skipIf(process.platform === 'win32')('WSL distro holder script', () => {
  it('holds while nothing asked for a release', async () => {
    const { exited } = startHolder()
    expect(await within(2_500, exited)).toBe('running')
  })

  it('drops a request left from before it started: a client wants the distro now', async () => {
    writeFileSync(releasePath(), '999999\n')
    const { exited } = startHolder()
    expect(await within(2_500, exited)).toBe('running')
    expect(existsSync(releasePath())).toBe(false)
  })

  it('waits for the requesting orcad to exit, then claims the request and ends', async () => {
    const holder = startHolder()
    expect(await within(300, holder.exited)).toBe('running')
    const orcad = track(spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' }))
    writeFileSync(releasePath(), `${orcad.pid}\n`)

    expect(await within(2_500, holder.exited)).toBe('running')
    orcad.kill('SIGKILL')
    expect(await within(4_000, holder.exited)).toBe(0)
    expect(existsSync(releasePath())).toBe(false)
  })

  it('keeps holding when a starting orcad withdrew the request first', async () => {
    const holder = startHolder()
    expect(await within(300, holder.exited)).toBe('running')
    const orcad = track(spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' }))
    writeFileSync(releasePath(), `${orcad.pid}\n`)
    await within(1_500, holder.exited)
    rmSync(releasePath())
    orcad.kill('SIGKILL')
    expect(await within(3_000, holder.exited)).toBe('running')
  })

  it('ignores a request it cannot read as a pid', async () => {
    const holder = startHolder()
    expect(await within(300, holder.exited)).toBe('running')
    writeFileSync(releasePath(), 'not-a-pid\n')
    expect(await within(2_500, holder.exited)).toBe('running')
  })

  it('never releases without a home to find the request in', async () => {
    writeFileSync(releasePath(), '999999\n')
    const { exited } = startHolder({ PATH: process.env.PATH })
    expect(await within(2_500, exited)).toBe('running')
  })

  it('keeps the distro while the user still runs something, and lets go once it ends', async () => {
    // e.g. a detached tmux server or a nohup'd job started from an Orca terminal.
    const job = fakeProcess(4242)
    const { exited } = await holderWithRequest()
    expect(await within(2_500, exited)).toBe('running')
    expect(existsSync(releasePath())).toBe(true)
    rmSync(job, { recursive: true })
    expect(await within(3_000, exited)).toBe(0)
  })

  it('keeps the distro while a container runs, though its shim belongs to root', async () => {
    const shim = fakeProcess(4343, { name: 'containerd-shim-runc-v2', uid: 0 })
    // dockerd itself, idle and root-owned, is a system service, not work.
    fakeProcess(4344, { name: 'dockerd', uid: 0 })
    const { exited } = await holderWithRequest()
    expect(await within(2_500, exited)).toBe('running')
    rmSync(shim, { recursive: true })
    expect(await within(3_000, exited)).toBe(0)
  })

  it('does not count session plumbing, zombies, other users or its own children', async () => {
    let pid = 5000
    for (const name of WSL_DISTRO_HOLDER_IGNORED_PROCESS_NAMES) {
      fakeProcess(pid++, { name })
    }
    fakeProcess(pid++, { state: 'Z (zombie)' })
    fakeProcess(pid++, { uid: me + 1 })
    const holder = startHolder()
    fakeProcess(pid++, { name: 'sleep', ppid: holder.child.pid })
    expect(await within(300, holder.exited)).toBe('running')
    const orcad = track(spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }))
    await new Promise((resolve) => orcad.once('exit', resolve))
    writeFileSync(releasePath(), `${orcad.pid}\n`)
    expect(await within(3_000, holder.exited)).toBe(0)
  })

  it('notes what keeps it holding, and clears the note once it releases', async () => {
    const job = fakeProcess(4242, { name: 'node' })
    const { exited } = await holderWithRequest()
    await expect.poll(() => existsSync(blockedPath()), { timeout: 5_000 }).toBe(true)
    expect(readFileSync(blockedPath(), 'utf8')).toBe('node\n')
    rmSync(job, { recursive: true })
    expect(await within(3_000, exited)).toBe(0)
    expect(existsSync(blockedPath())).toBe(false)
  })

  it('keeps the note bounded however much the user runs', async () => {
    for (let pid = 6000; pid < 6000 + 3 * WSL_DISTRO_HOLDER_BLOCKED_NAMES_MAX; pid++) {
      fakeProcess(pid, { name: `job${pid}` })
    }
    const { exited } = await holderWithRequest()
    await expect.poll(() => existsSync(blockedPath()), { timeout: 5_000 }).toBe(true)
    expect(readFileSync(blockedPath(), 'utf8').trim().split(' ')).toHaveLength(
      WSL_DISTRO_HOLDER_BLOCKED_NAMES_MAX
    )
    expect(await within(1_500, exited)).toBe('running')
  })

  it('fails closed when /proc cannot be read', async () => {
    const { exited } = await holderWithRequest({ procReadable: false })
    expect(await within(2_500, exited)).toBe('running')
    expect(readFileSync(blockedPath(), 'utf8')).toBe('proc-unreadable\n')
  })

  it('fails closed on a status file it cannot parse', async () => {
    const dir = join(proc, '7000')
    mkdirSync(dir)
    writeFileSync(join(dir, 'status'), 'Name:\tmystery\n')
    const { exited } = await holderWithRequest()
    expect(await within(2_500, exited)).toBe('running')
    expect(readFileSync(blockedPath(), 'utf8')).toBe('mystery\n')
  })

  it("counts an unreadable entry only when it is the user's own (hidepid=noaccess)", async () => {
    // Root's status files are unreadable under hidepid; their directories still show their owner.
    const dir = join(proc, '7100')
    mkdirSync(dir)
    writeFileSync(join(dir, 'status'), 'Name:\tsecret\n')
    chmodSync(join(dir, 'status'), 0o000)
    // The user's own unreadable entry holds.
    const own = await holderWithRequest()
    expect(await within(2_500, own.exited)).toBe('running')
    own.child.kill('SIGKILL')
    // Seen by another user, the same entry is someone else's and does not hold.
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'id'), `#!/bin/sh\necho ${me + 1}\n`, { mode: 0o755 })
    const other = await holderWithRequest({ path: `${bin}:${process.env.PATH}` })
    expect(await within(3_000, other.exited)).toBe(0)
  })

  it('cleans up a note a killed holder left half-written', async () => {
    const stale = `${blockedPath()}.12345`
    writeFileSync(stale, 'half')
    const { exited } = startHolder()
    expect(await within(500, exited)).toBe('running')
    expect(existsSync(stale)).toBe(false)
  })
})
