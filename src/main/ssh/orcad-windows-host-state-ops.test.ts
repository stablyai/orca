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
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
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
