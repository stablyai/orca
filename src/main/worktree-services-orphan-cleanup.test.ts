import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'

const execMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, exec: execMock }
})

import { cleanupOrphanedWorktreeServices } from './worktree-services-orphan-cleanup'
import {
  getWorktreeServicesRecord,
  upsertWorktreeServicesRecord
} from '../shared/worktree-services-store'
import type { WorktreeServicesRecord } from '../shared/worktree-services'
import type { Repo } from '../shared/types'

let userDataDir: string
let repoDir: string
beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-svc-orphan-'))
  repoDir = mkdtempSync(join(tmpdir(), 'orca-svc-orphan-repo-'))
  execMock.mockReset()
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(null, 'ok', '')
    return { kill: vi.fn() }
  })
  writeFileSync(
    join(repoDir, 'orca.yaml'),
    [
      'services:',
      '  - id: db',
      '    name: Postgres',
      '    create: echo create',
      '    destroy: echo destroy'
    ].join('\n')
  )
})
afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

function record(worktreeId: string, slot: number): WorktreeServicesRecord {
  return {
    worktreeId,
    repoId: 'repo-1',
    slot,
    slug: `wt-s${slot}`,
    serviceIds: ['db'],
    env: { ORCA_SERVICE_SLOT: String(slot) },
    status: 'ready',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z'
  }
}

describe('cleanupOrphanedWorktreeServices', () => {
  it('destroys orphaned records and leaves live ones untouched', async () => {
    upsertWorktreeServicesRecord(userDataDir, record('wt-gone', 0))
    upsertWorktreeServicesRecord(userDataDir, record('wt-live', 1))
    await cleanupOrphanedWorktreeServices({
      userDataPath: userDataDir,
      existingWorktreeIds: new Set(['wt-live']),
      resolveRepo: () => ({ id: 'repo-1', path: repoDir }) as Repo
    })
    expect(execMock).toHaveBeenCalled()
    expect(getWorktreeServicesRecord(userDataDir, 'wt-gone')).toBeNull()
    expect(getWorktreeServicesRecord(userDataDir, 'wt-live')).not.toBeNull()
  })

  it('removes the orphan without running destroy when the repo is unresolvable', async () => {
    upsertWorktreeServicesRecord(userDataDir, record('wt-gone', 0))
    await cleanupOrphanedWorktreeServices({
      userDataPath: userDataDir,
      existingWorktreeIds: new Set(),
      resolveRepo: () => null
    })
    expect(execMock).not.toHaveBeenCalled()
    expect(getWorktreeServicesRecord(userDataDir, 'wt-gone')).toBeNull()
  })

  it('demotes an interrupted provisioning record for a still-existing worktree', async () => {
    upsertWorktreeServicesRecord(userDataDir, { ...record('wt-live', 0), status: 'provisioning' })
    await cleanupOrphanedWorktreeServices({
      userDataPath: userDataDir,
      existingWorktreeIds: new Set(['wt-live']),
      resolveRepo: () => ({ id: 'repo-1', path: repoDir }) as Repo
    })
    const demoted = getWorktreeServicesRecord(userDataDir, 'wt-live')
    expect(demoted?.status).toBe('create_failed')
    expect(demoted?.error).toContain('interrupted')
    // The worktree still exists, so it is not an orphan — destroy must not run.
    expect(execMock).not.toHaveBeenCalled()
  })
})
