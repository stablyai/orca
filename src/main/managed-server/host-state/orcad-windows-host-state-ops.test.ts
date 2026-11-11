import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
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

  it('fails closed on a link inside captured state', async () => {
    symlinkSync(join(dir), join(root, 'profiles', 'escape'), 'junction')
    expect(await op('snapshot-capture', root, snapshot)).toBe('FAILED')
    expect(await op('snapshot-probe', snapshot)).toBe('ABSENT')
  })

  it('clears the members of a root that started empty, leaving the daemon', async () => {
    expect(await op('snapshot-clear', root)).toBe('RESTORED')
    expect(existsSync(join(root, 'profiles'))).toBe(false)
    expect(existsSync(join(root, 'orca-profile-index.json'))).toBe(false)
    expect(existsSync(join(root, 'daemon', 'daemon.sock.token'))).toBe(true)
  })
})

describe('Windows owner admission', () => {
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

  /** Simulate process-tree creation-time proof for every tested PID. */
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
    // Without a process-tree addon, creation-time proof is unavailable.
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
})
