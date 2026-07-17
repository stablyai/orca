import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'

const execMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, exec: execMock }
})

import {
  destroyWorktreeServices,
  getWorktreeServicesRuntime,
  loadServiceRecipesForWorktree,
  provisionWorktreeServices,
  runWorktreeServiceAction
} from './worktree-services'
import {
  allocateServiceSlot,
  getWorktreeServicesRecord,
  listWorktreeServicesRecords
} from '../shared/worktree-services-store'
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

  it('keeps allocated ORCA context authoritative over legacy recipe env', async () => {
    execSucceeds()
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services: [{ ...services[0]!, env: { ORCA_PORT_0: '29999' } }]
    })
    expect(record.env.ORCA_PORT_0).toBe('20000')
  })

  it('persists retryable failure state when no valid recipes remain', async () => {
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services: []
    })
    expect(record.status).toBe('create_failed')
    expect(record.error).toContain('no valid')
    expect(getWorktreeServicesRecord(dir, 'wt-1')).toEqual(record)
    expect(execMock).not.toHaveBeenCalled()
  })

  it('survives a provision event listener that throws mid-stream', async () => {
    execMock.mockImplementation((_cmd, _opts, cb) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      })
      queueMicrotask(() => {
        child.stdout.emit('data', 'pulling image…')
        cb(null, 'ok', '')
      })
      return child
    })
    const record = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services,
      onEvent: () => {
        throw new Error('window destroyed')
      }
    })
    expect(record.status).toBe('ready')
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

  it('marks create_failed when child-process startup throws synchronously', async () => {
    execMock.mockImplementation(() => {
      throw new Error('invalid environment')
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
    expect(record.error).toContain('invalid environment')
  })

  it('reuses the slot and slug when re-provisioning an existing ready record', async () => {
    execSucceeds()
    const first = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'My Task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    const second = await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'Renamed Task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    expect(second.slot).toBe(first.slot)
    expect(second.slug).toBe(first.slug)
    // A single record — no orphaned prior slug on a fresh slot.
    expect(listWorktreeServicesRecords(dir)).toHaveLength(1)
    // Slot 0 stays taken by the reused record, so the next allocation is 1.
    expect(allocateServiceSlot(dir)).toBe(1)
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

  it('retains the record and slot when the caller has not committed removal', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      repo,
      services,
      releaseRecord: false
    })
    expect(getWorktreeServicesRecord(dir, 'wt-1')).not.toBeNull()
    expect(allocateServiceSlot(dir)).toBe(1)
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

  it('reports an error when a provisioned service is no longer declared in orca.yaml', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    // Drift: the recipes resolved at destroy time no longer declare "db".
    const driftedServices: OrcaServiceRecipe[] = [
      { id: 'redis', name: 'Redis', create: 'echo up', destroy: 'echo down' }
    ]
    const result = await destroyWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      repo,
      services: driftedServices
    })
    expect(result.success).toBe(false)
    expect(result.errors.some((e) => e.includes('db') && e.includes('no longer declared'))).toBe(
      true
    )
    expect(getWorktreeServicesRecord(dir, 'wt-1')).toBeNull()
  })
})

describe('getWorktreeServicesRuntime', () => {
  it('starts independent status probes concurrently and preserves recipe order', async () => {
    const runtimeServices: OrcaServiceRecipe[] = [
      { ...services[0]!, status: 'status-db' },
      { id: 'cache', name: 'Cache', create: 'create-cache', status: 'status-cache' }
    ]
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services: runtimeServices
    })

    let releaseProbes!: () => void
    const probesMayFinish = new Promise<void>((resolve) => {
      releaseProbes = resolve
    })
    execMock.mockReset()
    execMock.mockImplementation((_cmd, _opts, cb) => {
      void probesMayFinish.then(() => cb(null, '', ''))
      return { kill: vi.fn() }
    })

    const runtimePromise = getWorktreeServicesRuntime({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      services: runtimeServices
    })
    expect(execMock).toHaveBeenCalledTimes(2)
    releaseProbes()
    await expect(runtimePromise).resolves.toMatchObject([
      { serviceId: 'db', runState: 'running' },
      { serviceId: 'cache', runState: 'running' }
    ])
  })
})

describe('runWorktreeServiceAction', () => {
  it('fails when the targeted service is not provisioned', async () => {
    execSucceeds()
    await provisionWorktreeServices({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreeName: 'task',
      worktreePath: '/tmp/x',
      repo,
      services
    })
    execMock.mockClear()
    const result = await runWorktreeServiceAction({
      userDataPath: dir,
      worktreeId: 'wt-1',
      worktreePath: '/tmp/x',
      services,
      action: 'start',
      serviceId: 'ghost'
    })
    expect(result.success).toBe(false)
    expect(result.errors[0]).toContain('ghost')
    expect(execMock).not.toHaveBeenCalled()
  })
})

describe('loadServiceRecipesForWorktree', () => {
  it('prefers the worktree orca.yaml over the repo root', () => {
    const worktreeDir = join(dir, 'wt')
    const repoDir = join(dir, 'repo')
    mkdirSync(worktreeDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(
      join(worktreeDir, 'orca.yaml'),
      'services:\n  - id: branch-db\n    name: Branch DB\n    create: echo up\n'
    )
    writeFileSync(
      join(repoDir, 'orca.yaml'),
      'services:\n  - id: root-db\n    name: Root DB\n    create: echo up\n'
    )
    expect(loadServiceRecipesForWorktree(worktreeDir, repoDir).map((s) => s.id)).toEqual([
      'branch-db'
    ])
  })

  it('falls back to the repo root when the worktree declares no services', () => {
    const worktreeDir = join(dir, 'wt')
    const repoDir = join(dir, 'repo')
    mkdirSync(worktreeDir, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(worktreeDir, 'orca.yaml'), 'scripts:\n  setup: echo hi\n')
    writeFileSync(
      join(repoDir, 'orca.yaml'),
      'services:\n  - id: root-db\n    name: Root DB\n    create: echo up\n'
    )
    expect(loadServiceRecipesForWorktree(worktreeDir, repoDir).map((s) => s.id)).toEqual([
      'root-db'
    ])
  })

  it('returns empty when neither location declares services', () => {
    const worktreeDir = join(dir, 'wt')
    mkdirSync(worktreeDir, { recursive: true })
    expect(loadServiceRecipesForWorktree(worktreeDir, join(dir, 'missing'))).toEqual([])
  })
})
