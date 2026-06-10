import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeLockfile, removeLockfile, sweepOrphanLockfiles } from './lockfile'

describe('lockfile', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ide-lock-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes a lockfile named after the port with the right shape', () => {
    writeLockfile(dir, 12345, {
      pid: 999, workspaceFolders: ['/w'], ideName: 'Orca',
      transport: 'ws', runningInWindows: false, authToken: 'tok',
    })
    const path = join(dir, '12345.lock')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).authToken).toBe('tok')
  })

  it('removeLockfile deletes it', () => {
    writeLockfile(dir, 1, { pid: 1, workspaceFolders: [], ideName: 'Orca', transport: 'ws', runningInWindows: false, authToken: 't' })
    removeLockfile(dir, 1)
    expect(existsSync(join(dir, '1.lock'))).toBe(false)
  })

  it('sweepOrphanLockfiles removes lockfiles whose pid is dead', () => {
    writeFileSync(join(dir, '7.lock'), JSON.stringify({ pid: 2147480000, workspaceFolders: [], ideName: 'Orca', transport: 'ws', runningInWindows: false, authToken: 't' }))
    sweepOrphanLockfiles(dir)
    expect(existsSync(join(dir, '7.lock'))).toBe(false)
  })
})
