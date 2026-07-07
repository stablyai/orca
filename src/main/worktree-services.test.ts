import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'

const execMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, exec: execMock }
})

import { destroyWorktreeServices, provisionWorktreeServices } from './worktree-services'
import { getWorktreeServicesRecord } from '../shared/worktree-services-store'
import type { OrcaServiceRecipe, Repo } from '../shared/types'

const repo = { id: 'repo-1', path: '/tmp/repo' } as Repo
const services: OrcaServiceRecipe[] = [
  {
    id: 'db',
    name: 'Postgres',
    create: 'echo create-db',
    destroy: 'echo destroy-db',
    env: { DATABASE_URL: 'pg://localhost:${ORCA_PORT_0}/app' }
  }
]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-svc-main-'))
  execMock.mockReset()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function execSucceeds(): void {
  execMock.mockImplementation((_cmd, _opts, cb) => {
    cb(null, 'ok', '')
    return { kill: vi.fn() }
  })
}

describe('provisionWorktreeServices', () => {
  it('allocates slot 0, resolves env, persists a ready record', async () => {
    execSucceeds()
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'My Task',
      worktreePath: '/tmp/repo-worktrees/my-task',
      repo,
      services
    })
    expect(record.status).toBe('ready')
    expect(record.slot).toBe(0)
    expect(record.env.DATABASE_URL).toBe('pg://localhost:20000/app')
    expect(record.env.ORCA_WORKTREE_SLUG).toBe('my-task-s0')
    expect(getWorktreeServicesRecord(dir, 'wt-1')?.status).toBe('ready')
  })

  it('marks create_failed and keeps the record on command failure', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(new Error('boom'), '', 'docker: not found')
      return { kill: vi.fn() }
    })
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(record.status).toBe('create_failed')
    expect(record.error).toContain('db')
    expect(getWorktreeServicesRecord(dir, 'wt-1')?.status).toBe('create_failed')
  })
})

describe('destroyWorktreeServices', () => {
  it('runs destroy, removes the record, frees the slot', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(result).toEqual({ success: true, errors: [] })
    expect(getWorktreeServicesRecord(dir, 'wt-1')).toBeNull()
  })

  it('still removes the record when destroy fails, reporting the error', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    execMock.mockImplementation((_cmd, _opts, cb) => {
      cb(new Error('gone'), '', '')
      return { kill: vi.fn() }
    })
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(getWorktreeServicesRecord(dir, 'wt-1')).toBeNull()
  })

  it('is a no-op without a record', async () => {
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'nope',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(result).toEqual({ success: true, errors: [] })
    expect(execMock).not.toHaveBeenCalled()
  })
})
