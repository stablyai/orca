import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ORCAD_WSL_HOLDER_BLOCKED_FILENAME,
  ORCAD_WSL_HOLDER_RELEASE_FILENAME
} from '../../../shared/remote-runtime/orcad-lifecycle/orcad-idle-exit'
import { buildWslDistroHolderScript, WSL_DISTRO_HOLDER_MARKER } from './wsl-distro-holder-command'

// The script runs inside the distro; any POSIX sh here runs the same text. A fake /proc stands in
// for the distro's, so the test runner's own processes never count as the user's work.
let home: string
let proc: string
let children: ChildProcess[]
const me = userInfo().uid
/** A short poll keeps the suite fast; the script is otherwise the production text. */
const POLL_SECONDS = 0.1
/** Generous, so a loaded machine cannot fail a release. */
const RELEASE_BOUND_MS = 15_000

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

/** One fake /proc entry, as the kernel writes its status file. */
function fakeProcess(pid: number, fields: { name: string; ppid?: number; uid?: number }): void {
  const dir = join(proc, String(pid))
  mkdirSync(dir, { recursive: true })
  const uid = fields.uid ?? me
  writeFileSync(
    join(dir, 'status'),
    `Name:\t${fields.name}\nState:\tS (sleeping)\nPPid:\t${fields.ppid ?? 1}\nUid:\t${uid}\t${uid}\t0\t0\n`
  )
}

const blockedPath = (): string => join(home, '.orca', ORCAD_WSL_HOLDER_BLOCKED_FILENAME)
const readBlocked = (): string =>
  existsSync(blockedPath()) ? readFileSync(blockedPath(), 'utf8') : ''

/** A holder past its start-up cleanup, then a release request from an orcad that has exited. */
async function holderWithRequest(): Promise<{ exited: Promise<number | null> }> {
  const started = `${blockedPath()}.started`
  writeFileSync(started, '')
  const holder = spawn(
    '/bin/sh',
    ['-c', buildWslDistroHolderScript(POLL_SECONDS, proc), WSL_DISTRO_HOLDER_MARKER],
    { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' }
  )
  children.push(holder)
  const exited = new Promise<number | null>((resolve) => holder.once('exit', resolve))
  // A real /proc always shows the holder itself; without that entry the scan fails closed.
  fakeProcess(holder.pid ?? 0, { name: 'sh' })
  // Its start-up `rm -f` of stale notes is done once the sentinel is gone.
  await expect.poll(() => existsSync(started), { timeout: RELEASE_BOUND_MS }).toBe(false)
  const orcad = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
  await new Promise((resolve) => orcad.once('exit', resolve))
  writeFileSync(join(home, '.orca', ORCAD_WSL_HOLDER_RELEASE_FILENAME), `${orcad.pid}\n`)
  return { exited }
}

/** Whichever comes first: the holder's exit, or the busy note it writes when it decides to hold. */
async function outcome(exited: Promise<number | null>): Promise<string> {
  let code: number | null | undefined
  void exited.then((value) => {
    code = value
  })
  await expect
    .poll(() => code !== undefined || readBlocked() !== '', { timeout: RELEASE_BOUND_MS })
    .toBe(true)
  return code !== undefined ? `exit ${code}` : readBlocked()
}

async function holderOutcome(): Promise<string> {
  return outcome((await holderWithRequest()).exited)
}

describe.skipIf(process.platform === 'win32')('WSL distro holder script', () => {
  // QA repro (systemd distro): WSL parks `-bash` under a root `/bin/login -f` for the holder's
  // own account; the holder counted it and wrote `bash` to its blocked note forever.
  it("lets go despite the idle shell WSL's systemd login parks for the account", async () => {
    fakeProcess(500, { name: 'login', uid: 0 })
    fakeProcess(501, { name: 'bash', ppid: 500 })
    fakeProcess(502, { name: 'systemd' })
    expect(await holderOutcome()).toBe('exit 0')
  })

  it("still holds for another session's shell and for work under the login's shell", async () => {
    fakeProcess(500, { name: 'login', uid: 0 })
    fakeProcess(501, { name: 'bash', ppid: 500 })
    // Another wsl.exe session's shell runs under WSL's init (a root `init`), not under login.
    fakeProcess(600, { name: 'init', uid: 0 })
    fakeProcess(601, { name: 'bash', ppid: 600 })
    fakeProcess(502, { name: 'tmux', ppid: 501 })
    expect(await holderOutcome()).toBe('tmux bash\n')
  })

  it('still holds for a login that is not root, or a non-shell a login profile exec-ed', async () => {
    // A user-run `login` is the user's own: it and its shell both count.
    fakeProcess(500, { name: 'login' })
    fakeProcess(501, { name: 'bash', ppid: 500 })
    // A profile's `exec node server.js` replaces the login shell with real work.
    fakeProcess(700, { name: 'login', uid: 0 })
    fakeProcess(701, { name: 'node', ppid: 700 })
    expect(await holderOutcome()).toBe('login bash node\n')
  })
})
