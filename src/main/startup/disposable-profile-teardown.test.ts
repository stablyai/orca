import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chooseDaemonTeardown,
  proveDaemonExited,
  runsOnDisposableProfile,
  stateDeletionIsSafe
} from './disposable-profile-teardown'

const root = mkdtempSync(join(tmpdir(), 'orca-teardown-'))

function pidRecord(name: string, contents: string): string {
  const path = join(root, name)
  writeFileSync(path, contents)
  return path
}

describe('a disposable profile owns its daemon', () => {
  it('claims ownership for a candidate state root', () => {
    expect(runsOnDisposableProfile({ ORCA_DEV_USER_DATA_PATH: '/tmp/orca-pkgb-x' })).toBe(true)
  })

  it('leaves the packaged profile on the warm-reattach path', () => {
    // The real profile keeps its daemon: a user's terminals must survive a quit.
    expect(runsOnDisposableProfile({})).toBe(false)
  })
})

describe('exit is proven, never assumed', () => {
  it('proves exit only on ESRCH', () => {
    const path = pidRecord('gone.pid', JSON.stringify({ pid: 4242 }))
    const proof = proveDaemonExited(path, () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    expect(proof).toMatchObject({ verdict: 'exited', pid: 4242 })
    expect(stateDeletionIsSafe(proof)).toBe(true)
  })

  it('NEGATIVE CONTROL: a daemon that is still running blocks state deletion', () => {
    // Fifteen candidate state roots were deleted while their daemon and every
    // supervised agent kept running. This is that state.
    const path = pidRecord('alive.pid', JSON.stringify({ pid: process.pid }))
    const proof = proveDaemonExited(path)
    expect(proof.verdict).toBe('live')
    expect(stateDeletionIsSafe(proof)).toBe(false)
  })

  it('reports another user’s process as live, never as exited', () => {
    const path = pidRecord('eperm.pid', JSON.stringify({ pid: 1 }))
    const proof = proveDaemonExited(path, () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    expect(proof.verdict).toBe('live')
  })

  it('reports a missing or unreadable pid record as unverifiable, not as exited', () => {
    expect(proveDaemonExited(join(root, 'never-written.pid')).verdict).toBe('unverifiable')
    expect(proveDaemonExited(pidRecord('garbage.pid', 'not json')).verdict).toBe('unverifiable')
    expect(stateDeletionIsSafe(proveDaemonExited(join(root, 'never-written.pid')))).toBe(false)
  })

  it('reports an unrecognised probe failure as unverifiable', () => {
    const path = pidRecord('weird.pid', JSON.stringify({ pid: 5 }))
    expect(
      proveDaemonExited(path, () => {
        throw new Error('something else entirely')
      }).verdict
    ).toBe('unverifiable')
  })
})

describe('which teardown a quit takes', () => {
  it('kills the daemon for a disposable profile even on an ordinary quit', () => {
    // The warm path is what left the daemons up: a candidate quit normally, so
    // `disconnectDaemon()` ran and deliberately preserved the daemon.
    expect(
      chooseDaemonTeardown({ devParentShutdownRequested: false, disposableProfile: true })
    ).toBe('shutdown')
  })

  it('keeps the packaged profile on the warm-reattach path', () => {
    expect(
      chooseDaemonTeardown({ devParentShutdownRequested: false, disposableProfile: false })
    ).toBe('disconnect')
  })

  it('still kills the daemon when the dev parent died', () => {
    expect(
      chooseDaemonTeardown({ devParentShutdownRequested: true, disposableProfile: false })
    ).toBe('shutdown')
  })
})
