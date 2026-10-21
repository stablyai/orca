import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { captureOrcadStateSnapshotCommand, parseOrcadSnapshotCapture } from './orcad-state-snapshot'
import {
  orcadSnapshotFailureReason,
  orcadSnapshotShortfallKb,
  orcadSnapshotShortfallMessage,
  orcadSnapshotSpaceCommand,
  parseOrcadSnapshotSpace
} from './orcad-state-snapshot-space'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const SHELL = process.env.ORCA_TEST_POSIX_SHELL ?? '/bin/sh'
// Root reads a mode-000 file anyway, so the unreadable-state case only exists for other users.
const ROOT = process.getuid?.() === 0

async function sh(command: string, path?: string): Promise<string> {
  const env = path ? { ...process.env, PATH: `${path}:${process.env.PATH ?? ''}` } : process.env
  return (await runProcess({ program: SHELL, args: ['-c', command], env })).stdout
}

describe.skipIf(process.platform === 'win32')('snapshot room on a real shell (#30491)', () => {
  let base: string
  let root: string
  let snapshots: string
  let remoteBase: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'orcad-snapshot-space-'))
    root = join(base, 'root')
    remoteBase = join(base, '.orca-remote')
    snapshots = join(remoteBase, 'orcad-state-snapshots')
    mkdirSync(join(root, 'profiles', 'p1'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'p1', 'profile-state.db'), 'x'.repeat(64 * 1024))
    for (const name of ['pre-0.1.0+aa01-1', 'pre-0.1.0+bb02-2', 'rollback-rescue-0.1.0+bb02-3']) {
      mkdirSync(join(snapshots, name), { recursive: true })
      writeFileSync(join(snapshots, name, 'state.tar'), 'y'.repeat(64 * 1024))
    }
  })

  afterEach(() => {
    chmodSync(join(root, 'profiles', 'p1'), 0o700)
    rmSync(base, { recursive: true, force: true })
  })

  it.skipIf(ROOT)('removes its partial archive and says why when the copy fails', async () => {
    writeFileSync(join(root, 'profiles', 'p1', 'locked'), 'secret')
    chmodSync(join(root, 'profiles', 'p1', 'locked'), 0o000)
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')

    const output = await sh(captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase))

    expect(parseOrcadSnapshotCapture(output)).toBe('failed')
    expect(orcadSnapshotFailureReason(output)).toMatch(/Permission denied/u)
    // A leftover partial is a full copy of the state, and it fills the disk the retry needs.
    expect(existsSync(snapshot)).toBe(false)
  })

  it('prunes earlier captures but keeps the named ones and every rollback rescue', async () => {
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')
    const output = await sh(
      captureOrcadStateSnapshotCommand(posix, root, snapshot, remoteBase, {
        snapshotsRoot: snapshots,
        keep: ['pre-0.1.0+bb02-2', 'pre-0.2.0+cc03-4']
      })
    )

    expect(parseOrcadSnapshotCapture(output)).toBe('captured')
    expect(readdirSync(snapshots).sort()).toEqual([
      'pre-0.1.0+bb02-2',
      'pre-0.2.0+cc03-4',
      'rollback-rescue-0.1.0+bb02-3'
    ])
    expect(existsSync(join(snapshot, 'state.tar'))).toBe(true)
  })

  it('counts what a prune would reclaim as room, and refuses when even that is short', async () => {
    const bin = join(base, 'bin')
    mkdirSync(bin)
    writeFileSync(
      join(bin, 'df'),
      "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfiler:/home 100 100 0 100%% /home\\n'\n"
    )
    chmodSync(join(bin, 'df'), 0o755)
    const measure = async (keep: string[]) =>
      parseOrcadSnapshotSpace(
        await sh(orcadSnapshotSpaceCommand(posix, root, snapshots, remoteBase, keep) ?? '', bin)
      )

    const keepAll = await measure(['pre-0.1.0+aa01-1', 'pre-0.1.0+bb02-2'])
    const keepOne = await measure(['pre-0.1.0+bb02-2'])
    expect(keepAll?.availableKb).toBe(0)
    expect(keepAll?.neededKb).toBeGreaterThanOrEqual(64)
    expect(keepOne?.availableKb).toBeGreaterThanOrEqual(64)
    // Measuring never removes anything; only the capture prunes.
    expect(readdirSync(snapshots)).toHaveLength(3)

    const shortfall = orcadSnapshotShortfallKb(keepAll)
    expect(shortfall).toBeGreaterThan(0)
    expect(
      orcadSnapshotShortfallMessage(
        keepAll ?? { neededKb: 0, availableKb: 0, reclaimKb: 0 },
        shortfall ?? 0,
        {
          userDataDir: '/home/work/.orca',
          baseDir: '/home/work/.orca-remote',
          fullVersion: '0.1.0+77dfa08c40aa',
          active: '0.1.0+aa01'
        }
      )
    ).toMatch(
      /has 0 KB free, and.*left the current server \(0\.1\.0\+aa01\) in place.*Nothing was stopped/u
    )
  })

  it('answers UNMEASURED, which reads as unknown, when a scan overruns its deadline', async () => {
    const bin = join(base, 'bin')
    mkdirSync(bin)
    // Lets the syntax probe and the members' scan through; times out only the old snapshots'.
    writeFileSync(
      join(bin, 'timeout'),
      '#!/bin/sh\nshift\ncase "$*" in *orcad-state-snapshots*) exit 124;; esac\nexec "$@"\n'
    )
    chmodSync(join(bin, 'timeout'), 0o755)

    const output = await sh(
      orcadSnapshotSpaceCommand(posix, root, snapshots, remoteBase, []) ?? '',
      bin
    )

    expect(output.trim()).toBe('SNAPSHOT_SPACE UNMEASURED')
    expect(parseOrcadSnapshotSpace(output)).toBeNull()
  })

  it('reads no room answer from a host that printed none', () => {
    expect(parseOrcadSnapshotSpace('')).toBeNull()
    expect(orcadSnapshotShortfallKb(null)).toBeNull()
    expect(orcadSnapshotShortfallKb({ neededKb: 0, availableKb: 0, reclaimKb: 0 })).toBeNull()
  })
})
