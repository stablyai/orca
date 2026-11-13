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
import { orcadSnapshotFailureReason } from './orcad-state-snapshot-space'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'

const posix = getRemoteHostPlatform('linux-x64')
const SHELL = process.env.ORCA_TEST_POSIX_SHELL ?? '/bin/sh'
// Root bypasses mode-000 permissions, so only non-root runs exercise unreadable-state failure.
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
    // Partial snapshots consume disk needed by retries and must be removed.
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
})
