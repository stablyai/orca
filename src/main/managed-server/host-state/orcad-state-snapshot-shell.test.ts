import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { posixProcessGroupCommand } from './orcad-state-mutation-owner-record'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')

// Use /bin/sh to catch dash/BusyBox builtin differences from bash.
const SHELL = process.env.ORCA_TEST_POSIX_SHELL ?? '/bin/sh'

async function sh(command: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runProcess({
    program: SHELL,
    args: ['-c', command],
    ...(env ? { env: { ...process.env, ...env } } : {})
  })
  return result.stdout
}

describe.skipIf(process.platform === 'win32')('snapshot commands on a real shell', () => {
  let base: string
  let root: string
  let snapshot: string
  let remoteBase: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orcad-snapshot-shell-'))
    root = join(base, 'root')
    snapshot = join(base, 'snapshots', 'pre-1')
    remoteBase = join(base, '.orca-remote')
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
      parseOrcadSnapshotCapture(
        await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('captured')
    writeFileSync(join(root, 'profiles', 'p.json'), 'migrated')
    writeFileSync(join(root, 'profiles', 'added.json'), 'new')
    writeFileSync(join(root, 'daemon', 'token'), 'rotated')

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
    expect(existsSync(join(root, 'profiles', 'added.json'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'token'), 'utf8')).toBe('rotated')
    expect(existsSync(join(root, '.orcad-state-restore-stage'))).toBe(false)
  })

  it('captures on a BusyBox before 1.30, whose timeout only takes `-t SECS`', async () => {
    const bin = join(base, 'bin')
    mkdirSync(bin)
    // Older BusyBox timeout needs -t; bare seconds would be treated as the program.
    writeFileSync(
      join(bin, 'timeout'),
      '#!/bin/sh\n[ "$1" = "-t" ] || exit 127\nshift 2\n[ "$1" = "-s" ] && shift 2\nexec "$@"\n'
    )
    chmodSync(join(bin, 'timeout'), 0o755)

    expect(
      parseOrcadSnapshotCapture(
        await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase), {
          PATH: `${bin}:${process.env.PATH ?? ''}`
        })
      )
    ).toBe('captured')
  })

  it('keeps live state when the archive cannot be extracted', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    writeFileSync(join(snapshot, 'state.tar'), 'not a tar archive')
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('failed')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('current')
  })

  it('clears only the snapshot members for a root that started empty', async () => {
    expect(
      parseOrcadSnapshotRestore(
        await sh(clearOrcadStateSnapshotMembersCommand(posix, root, remoteBase))
      )
    ).toBe('restored')
    expect(existsSync(join(root, 'profiles'))).toBe(false)
    expect(readFileSync(join(root, 'daemon', 'token'), 'utf8')).toBe('live-daemon')
  })

  it('answers busy and leaves state alone while another state mutation holds the host lock', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')
    const lock = join(remoteBase, 'orcad-state-mutation.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), String(process.pid))

    const output = await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    expect(output.trim()).toBe('STATE_MUTATION_BUSY')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('current')
    expect(existsSync(lock)).toBe(true)
  })

  it('takes over a lock whose whole process group is gone, and releases it when done', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    writeFileSync(join(root, 'profiles', 'p.json'), 'current')
    const lock = join(remoteBase, 'orcad-state-mutation.lock')
    mkdirSync(lock)
    const exited = (await runProcess({ program: '/bin/sh', args: ['-c', 'echo $$'] })).stdout
    writeFileSync(join(lock, 'pid'), exited.trim())
    writeFileSync(join(lock, 'pgid'), exited.trim())

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
    expect(existsSync(lock)).toBe(false)
  })

  it('reads a process group from a proc stat whose command holds spaces and parens', async () => {
    const proc = join(base, 'proc')
    mkdirSync(join(proc, '4321'), { recursive: true })
    writeFileSync(join(proc, '4321', 'stat'), '4321 (we ird) (x)) S 1 777 777 0 -1 4194560 0 0')
    expect((await sh(posixProcessGroupCommand('4321', proc))).trim()).toBe('777')
  })
})
