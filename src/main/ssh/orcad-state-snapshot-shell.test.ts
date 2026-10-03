import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')

async function sh(command: string): Promise<string> {
  const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
  return result.stdout
}

describe.skipIf(process.platform === 'win32')('snapshot commands on a real shell', () => {
  let base: string
  let root: string
  let snapshot: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orcad-snapshot-shell-'))
    root = join(base, 'root')
    snapshot = join(base, 'snapshots', 'pre-1')
    mkdirSync(join(root, 'profiles'), { recursive: true })
    mkdirSync(join(root, 'daemon'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'p.json'), 'old')
    writeFileSync(join(root, 'daemon', 'token'), 'live-daemon')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('restores members, drops files the newer build added, and leaves the daemon alone', async () => {
    expect(
      parseOrcadSnapshotCapture(await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot)))
    ).toBe('captured')
    writeFileSync(join(root, 'profiles', 'p.json'), 'migrated')
    writeFileSync(join(root, 'profiles', 'added.json'), 'new')
    writeFileSync(join(root, 'daemon', 'token'), 'rotated')

    expect(
      parseOrcadSnapshotRestore(await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot)))
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
    expect(existsSync(join(root, 'profiles', 'added.json'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'token'), 'utf8')).toBe('rotated')
    expect(existsSync(join(root, '.orcad-state-restore-stage'))).toBe(false)
  })

  it('keeps live state when the archive cannot be extracted', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot))
    writeFileSync(join(snapshot, 'state.tar'), 'not a tar archive')
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')

    expect(
      parseOrcadSnapshotRestore(await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot)))
    ).toBe('failed')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('current')
  })

  it('reruns cleanly after a restore interrupted between removal and replacement', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot))
    // Simulates a crash that left the stage behind and the live members already removed.
    mkdirSync(join(root, '.orcad-state-restore-stage', 'profiles'), { recursive: true })
    rmSync(join(root, 'profiles'), { recursive: true })

    expect(
      parseOrcadSnapshotRestore(await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot)))
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
  })

  it('clears only the snapshot members for a root that started empty', async () => {
    expect(
      parseOrcadSnapshotRestore(await sh(clearOrcadStateSnapshotMembersCommand(posix, root)))
    ).toBe('restored')
    expect(existsSync(join(root, 'profiles'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'token'), 'utf8')).toBe('live-daemon')
  })
})
