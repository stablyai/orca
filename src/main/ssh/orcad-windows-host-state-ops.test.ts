/**
 * Runs the Windows host script's state ops under this machine's node, against real files:
 * the snapshot a rollback depends on, its comparison and restore, and owner admission.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { ORCAD_WINDOWS_HOST_SCRIPT, type OrcadWindowsHostOp } from './orcad-windows-host-script'

let dir = ''
let root = ''
let snapshot = ''
let script = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orcad-win-state-'))
  root = join(dir, '.orca')
  snapshot = join(dir, '.orca-remote', 'orcad-snapshots', 'pre-0.2.0+bb01-1')
  script = join(dir, 'orcad-host-script.js')
  writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
  mkdirSync(join(root, 'profiles', 'p1'), { recursive: true })
  mkdirSync(join(root, 'daemon'), { recursive: true })
  writeFileSync(join(root, 'orca-profile-index.json'), '{"v":"before"}')
  writeFileSync(join(root, 'profiles', 'p1', 'orca-data.json'), '{"repos":"before"}')
  writeFileSync(join(root, 'daemon', 'daemon.sock.token'), 'live-daemon-token')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function op(name: OrcadWindowsHostOp, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: process.execPath, args: [script, name, ...args] })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout.trim()
}

describe('Windows snapshot ops', () => {
  it('captures, proves unchanged, then restores the members and never the daemon', async () => {
    expect(await op('snapshot-probe', snapshot)).toBe('ABSENT')
    expect(await op('snapshot-capture', root, snapshot)).toBe('CAPTURED')
    expect(await op('snapshot-probe', snapshot)).toBe('PRESENT')
    expect(await op('snapshot-compare', root, snapshot)).toBe('UNCHANGED')

    writeFileSync(join(root, 'profiles', 'p1', 'orca-data.json'), '{"repos":"after"}')
    writeFileSync(join(root, 'profiles', 'p1', 'added.json'), '{}')
    writeFileSync(join(root, 'daemon', 'daemon.sock.token'), 'rotated-token')
    expect(await op('snapshot-compare', root, snapshot)).toBe('CHANGED')

    expect(await op('snapshot-restore', root, snapshot)).toBe('RESTORED')
    expect(readFileSync(join(root, 'profiles', 'p1', 'orca-data.json'), 'utf8')).toBe(
      '{"repos":"before"}'
    )
    expect(existsSync(join(root, 'profiles', 'p1', 'added.json'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'daemon.sock.token'), 'utf8')).toBe('rotated-token')
    expect(existsSync(join(root, '.orcad-state-restore-stage'))).toBe(false)
    expect(await op('snapshot-compare', root, snapshot)).toBe('UNCHANGED')
  })

  it('reports EMPTY rather than fabricating a snapshot of a root with no state', async () => {
    const empty = join(dir, 'empty-root')
    mkdirSync(empty)
    expect(await op('snapshot-capture', empty, snapshot)).toBe('EMPTY')
    expect(await op('snapshot-probe', snapshot)).toBe('ABSENT')
  })

  it('fails closed on a link inside captured state', async () => {
    symlinkSync(join(dir), join(root, 'profiles', 'escape'), 'junction')
    expect(await op('snapshot-capture', root, snapshot)).toBe('FAILED')
    expect(await op('snapshot-probe', snapshot)).toBe('ABSENT')
  })

  it('answers MISSING, UNKNOWN and FAILED rather than guessing', async () => {
    expect(await op('snapshot-restore', root, snapshot)).toBe('MISSING')
    expect(await op('snapshot-compare', root, snapshot)).toBe('UNKNOWN')
    expect(await op('snapshot-compare', join(dir, 'no-root'), snapshot)).toBe('UNKNOWN')
  })

  it('clears the members of a root that started empty, leaving the daemon', async () => {
    expect(await op('snapshot-clear', root)).toBe('RESTORED')
    expect(existsSync(join(root, 'profiles'))).toBe(false)
    expect(existsSync(join(root, 'orca-profile-index.json'))).toBe(false)
    expect(existsSync(join(root, 'daemon', 'daemon.sock.token'))).toBe(true)
  })

  it('reports the newest member write in epoch seconds, or UNKNOWN', async () => {
    const at = new Date('2026-09-30T12:00:00.000Z')
    utimesSync(join(root, 'orca-profile-index.json'), at, at)
    utimesSync(join(root, 'profiles', 'p1', 'orca-data.json'), at, at)
    expect(await op('state-newest-mtime', root)).toBe(String(Math.floor(at.getTime() / 1000)))
    const empty = join(dir, 'empty-root')
    mkdirSync(empty)
    expect(await op('state-newest-mtime', empty)).toBe('UNKNOWN')
  })
})

describe('Windows owner admission', () => {
  it('is CLEAR with no owners, LIVE for a running owner, and silent for a dead one', async () => {
    expect(await op('owner-admission', root)).toBe('CLEAR')
    writeFileSync(join(root, 'orcad.lock'), JSON.stringify({ pid: process.pid }))
    expect(await op('owner-admission', root)).toBe(`LIVE orcad.lock ${process.pid}`)
    writeFileSync(join(root, 'orcad.lock'), JSON.stringify({ pid: 4_194_303 }))
    expect(await op('owner-admission', root)).toBe('CLEAR')
  })

  it('refuses a record it cannot interpret', async () => {
    writeFileSync(join(root, 'orcad.lock'), 'not json')
    expect(await op('owner-admission', root)).toBe('UNVERIFIABLE orcad.lock')
    writeFileSync(join(root, 'orcad.lock'), JSON.stringify({ pid: -1 }))
    expect(await op('owner-admission', root)).toBe('UNVERIFIABLE orcad.lock')
  })
})

describe('the Windows state-mutation lock', () => {
  const lockDir = (): string => join(dir, 'orcad-state-mutation.lock')
  const holdLock = (owner: { pid: number; creationTimeMs?: number }): void => {
    mkdirSync(lockDir())
    writeFileSync(join(lockDir(), 'owner.json'), JSON.stringify(owner))
  }
  const mutations = [
    ['snapshot-restore', () => [root, snapshot]],
    ['snapshot-capture', () => [root, snapshot]],
    ['snapshot-clear', () => [root]]
  ] as const

  /** Runs an op with the slot's process-tree addon answering `createdAt` for every pid. */
  async function opWithAddon(createdAt: number, name: OrcadWindowsHostOp, ...args: string[]) {
    const slot = join(dir, 'orcad-0.2.0+bb01')
    mkdirSync(slot, { recursive: true })
    writeFileSync(join(slot, 'windows-process-tree.node'), '')
    const preload = join(dir, 'fake-process-tree.cjs')
    writeFileSync(
      preload,
      `const Module = require('module'); const load = Module._extensions['.node'];
Module._extensions['.node'] = (m, file) => file.endsWith('windows-process-tree.node')
  ? (m.exports = { getProcessCreationTime: () => ${createdAt} }) : load(m, file)`
    )
    const result = await runProcess({
      program: process.execPath,
      args: ['--require', preload, script, name, ...args]
    })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }

  it('releases the lock even when an op answers before its first await', async () => {
    expect(await op('snapshot-restore', root, join(dir, 'no-snapshot'))).toBe('MISSING')
    expect(existsSync(lockDir())).toBe(false)

    const empty = join(dir, 'empty-root')
    mkdirSync(empty)
    expect(await op('snapshot-capture', empty, snapshot)).toBe('EMPTY')
    expect(existsSync(lockDir())).toBe(false)

    symlinkSync(join(root, 'daemon'), join(root, 'profiles', 'p1', 'linked'))
    expect(await op('snapshot-capture', root, snapshot)).toBe('FAILED')
    expect(existsSync(lockDir())).toBe(false)
  })

  it('answers busy and leaves state alone while the same live process holds it', async () => {
    expect(await op('snapshot-capture', root, snapshot)).toBe('CAPTURED')
    writeFileSync(join(root, 'orca-profile-index.json'), '{"v":"current"}')
    holdLock({ pid: process.pid, creationTimeMs: 1234 })
    for (const [name, args] of mutations) {
      expect(await opWithAddon(1234, name, ...args())).toBe('STATE_MUTATION_BUSY')
    }
    expect(readFileSync(join(root, 'orca-profile-index.json'), 'utf8')).toBe('{"v":"current"}')
    expect(existsSync(lockDir())).toBe(true)
  })

  it('takes over a lock whose pid now belongs to another process', async () => {
    expect(await op('snapshot-capture', root, snapshot)).toBe('CAPTURED')
    writeFileSync(join(root, 'orca-profile-index.json'), '{"v":"current"}')
    holdLock({ pid: process.pid, creationTimeMs: 1234 })
    expect(await opWithAddon(5678, 'snapshot-restore', root, snapshot)).toBe('RESTORED')
    expect(readFileSync(join(root, 'orca-profile-index.json'), 'utf8')).toBe('{"v":"before"}')
    expect(existsSync(lockDir())).toBe(false)
  })

  it('takes over a lock whose holder exited', async () => {
    expect(await op('snapshot-capture', root, snapshot)).toBe('CAPTURED')
    const exited = await runProcess({ program: process.execPath, args: ['-p', 'process.pid'] })
    holdLock({ pid: Number(exited.stdout.trim()), creationTimeMs: 1234 })
    expect(await op('snapshot-restore', root, snapshot)).toBe('RESTORED')
    expect(existsSync(lockDir())).toBe(false)
  })

  it('keeps a live holder it cannot identify, however long it has been quiet, until it exits', async () => {
    expect(await op('snapshot-capture', root, snapshot)).toBe('CAPTURED')
    // No process-tree addon here, so the creation time is unreadable.
    holdLock({ pid: process.pid, creationTimeMs: 1234 })
    utimesSync(lockDir(), new Date(0), new Date(0))
    expect(await op('snapshot-restore', root, snapshot)).toBe('STATE_MUTATION_BUSY')

    const exited = await runProcess({ program: process.execPath, args: ['-p', 'process.pid'] })
    writeFileSync(
      join(lockDir(), 'owner.json'),
      JSON.stringify({ pid: Number(exited.stdout.trim()) })
    )
    expect(await op('snapshot-restore', root, snapshot)).toBe('RESTORED')
  })

  it('never lets a restore run under a suspended clear it cannot identify', async () => {
    expect(await op('snapshot-capture', root, snapshot)).toBe('CAPTURED')
    const ready = join(dir, 'ready')
    const resume = join(dir, 'resume')
    const finished = join(dir, 'finished')
    const preload = join(dir, 'pause-rm.cjs')
    // Holds the clear inside its first member removal, as a suspended or starved process would.
    writeFileSync(
      preload,
      `const fs = require('fs'); const rm = fs.promises.rm;
fs.promises.rm = async function (p, ...rest) {
  if (p === ${JSON.stringify(join(root, 'profiles'))}) {
    fs.writeFileSync(${JSON.stringify(ready)}, '')
    while (!fs.existsSync(${JSON.stringify(resume)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  return rm.call(this, p, ...rest)
}
process.on('exit', () => fs.writeFileSync(${JSON.stringify(finished)}, ''))`
    )
    const clear = spawnProcess({
      program: process.execPath,
      args: ['--require', preload, script, 'snapshot-clear', root]
    })
    try {
      await expect.poll(() => existsSync(ready), { timeout: 10_000 }).toBe(true)
      const owner = JSON.parse(readFileSync(join(lockDir(), 'owner.json'), 'utf8'))
      expect(owner.creationTimeMs).toBeNull()
      utimesSync(lockDir(), new Date(0), new Date(0))

      expect(await op('snapshot-restore', root, snapshot)).toBe('STATE_MUTATION_BUSY')
      writeFileSync(resume, '')
      await expect.poll(() => existsSync(finished), { timeout: 10_000 }).toBe(true)
      expect(existsSync(lockDir())).toBe(false)
      expect(await op('snapshot-restore', root, snapshot)).toBe('RESTORED')
      expect(existsSync(join(root, 'profiles', 'p1', 'orca-data.json'))).toBe(true)
    } finally {
      writeFileSync(resume, '')
      clear.kill('SIGKILL')
    }
  }, 30_000)
})

describe('the Windows state-mutation fence heartbeat', () => {
  const fencedOp = (fence: string, token: string, name: OrcadWindowsHostOp, ...args: string[]) =>
    runProcess({
      program: process.execPath,
      args: [script, '--fence', fence, token, name, ...args]
    })

  it('refreshes only a fence its run still owns, refuses a superseded run, and never creates one', async () => {
    const fence = join(dir, '.orcad-activation-transaction', '.install-lock')
    mkdirSync(fence, { recursive: true })
    writeFileSync(join(fence, '.orca-fence-owner'), 'holder-1')
    utimesSync(fence, new Date(0), new Date(0))
    expect(await fencedOp(fence, 'holder-1', 'snapshot-capture', root, snapshot)).toMatchObject({
      code: 0,
      stdout: 'CAPTURED'
    })
    expect(Date.now() - statSync(fence).mtimeMs).toBeLessThan(60_000)

    // Outside any fence's run, nothing refreshes it.
    utimesSync(fence, new Date(0), new Date(0))
    expect(await op('snapshot-restore', root, snapshot)).toBe('RESTORED')
    expect(statSync(fence).mtimeMs).toBe(0)

    // A run another took the fence over from never mutates, and leaves the successor's token.
    writeFileSync(join(fence, '.orca-fence-owner'), 'successor')
    expect(await fencedOp(fence, 'holder-1', 'snapshot-restore', root, snapshot)).toMatchObject({
      code: 75,
      stdout: '__ORCAD_FENCE_LOST__\n'
    })
    expect(statSync(fence).mtimeMs).toBe(0)
    expect(readFileSync(join(fence, '.orca-fence-owner'), 'utf8')).toBe('successor')

    rmSync(fence, { recursive: true })
    expect(await op('snapshot-restore', root, snapshot)).toBe('RESTORED')
    expect(existsSync(fence)).toBe(false)
  })
})
