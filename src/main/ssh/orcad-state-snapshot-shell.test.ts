import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand,
  serializedStateMutationCommand
} from './orcad-state-snapshot'
import { posixProcessGroupCommand } from './orcad-state-mutation-owner-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')

// Linux hosts often run dash as /bin/sh; its builtins differ from bash's (`kill -- -pgid`).
const SHELL = process.env.ORCA_TEST_POSIX_SHELL ?? '/bin/sh'

async function sh(command: string): Promise<string> {
  const result = await runProcess({ program: SHELL, args: ['-c', command] })
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

  it('reruns cleanly after a restore interrupted between removal and replacement', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    // Simulates a crash that left the stage behind and the live members already removed.
    mkdirSync(join(root, '.orcad-state-restore-stage', 'profiles'), { recursive: true })
    rmSync(join(root, 'profiles'), { recursive: true })

    expect(
      parseOrcadSnapshotRestore(
        await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
      )
    ).toBe('restored')
    expect(readFileSync(join(root, 'profiles', 'p.json'), 'utf8')).toBe('old')
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
    // This test process is alive, so it reads as a restore still running.
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

  it('on a host that recorded no group, waits on a live pid or a recent beat, then takes over', async () => {
    await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))
    const lock = join(remoteBase, 'orcad-state-mutation.lock')
    mkdirSync(lock, { recursive: true })
    const restore = async (): Promise<string> =>
      (await sh(restoreOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))).trim()
    const old = new Date(Date.now() - 10 * 60_000)

    writeFileSync(join(lock, 'pid'), String(process.pid))
    utimesSync(lock, old, old)
    expect(await restore()).toBe('STATE_MUTATION_BUSY')

    const exited = (await runProcess({ program: '/bin/sh', args: ['-c', 'echo $$'] })).stdout
    writeFileSync(join(lock, 'pid'), exited.trim())
    utimesSync(lock, new Date(), new Date())
    expect(await restore()).toBe('STATE_MUTATION_BUSY')

    // A dead pid and three missed beats: nothing of that run is provably left.
    utimesSync(lock, old, old)
    expect(parseOrcadSnapshotRestore(await restore())).toBe('restored')
    expect(existsSync(lock)).toBe(false)
  })

  it('reads a process group from a proc stat whose command holds spaces and parens', async () => {
    const proc = join(base, 'proc')
    mkdirSync(join(proc, '4321'), { recursive: true })
    writeFileSync(join(proc, '4321', 'stat'), '4321 (we ird) (x)) S 1 777 777 0 -1 4194560 0 0')
    expect((await sh(posixProcessGroupCommand('4321', proc))).trim()).toBe('777')
  })

  it.skipIf(!existsSync('/proc/self/stat'))(
    'records the group from /proc where ps has no -p (BusyBox)',
    async () => {
      const shim = join(base, 'bin')
      mkdirSync(shim)
      writeFileSync(
        join(shim, 'ps'),
        '#!/bin/sh\necho "ps: unrecognized option: p" >&2\nexit 1\n',
        {
          mode: 0o755
        }
      )
      const lock = join(remoteBase, 'orcad-state-mutation.lock')
      const run = spawnProcess({
        program: SHELL,
        args: [
          '-c',
          `PATH='${shim}':"$PATH"; ${serializedStateMutationCommand(remoteBase, 'sleep 5', 1)}`
        ]
      })
      try {
        await expect.poll(() => existsSync(join(lock, 'pgid'))).toBe(true)
        expect(Number(readFileSync(join(lock, 'pgid'), 'utf8'))).toBeGreaterThan(1)
      } finally {
        run.kill('SIGKILL')
      }
    },
    20_000
  )

  it('keeps the lock while a killed shell’s child still runs, and frees it once the group is gone', async () => {
    const lock = join(remoteBase, 'orcad-state-mutation.lock')
    // Stands in for a restore whose shell dies while its rm or tar keeps going.
    const run = spawnProcess({
      program: SHELL,
      args: ['-c', serializedStateMutationCommand(remoteBase, 'sleep 30; echo DONE', 1)]
    })
    try {
      await expect
        .poll(() => existsSync(join(lock, 'pid')) && existsSync(join(lock, 'pgid')))
        .toBe(true)
      const shell = Number(readFileSync(join(lock, 'pid'), 'utf8'))
      const group = Number(readFileSync(join(lock, 'pgid'), 'utf8'))
      expect(group).toBeGreaterThan(1)
      process.kill(shell, 'SIGKILL')

      const next = (): Promise<string> =>
        sh(serializedStateMutationCommand(remoteBase, 'echo RAN', 1))
      expect((await next()).trim()).toBe('STATE_MUTATION_BUSY')

      process.kill(-group, 'SIGKILL')
      await expect.poll(async () => (await next()).trim(), { timeout: 5_000 }).toBe('RAN')
      expect(existsSync(lock)).toBe(false)
    } finally {
      run.kill('SIGKILL')
    }
  }, 20_000)
})
