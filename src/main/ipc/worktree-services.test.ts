import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: never) => Promise<unknown> | unknown>()
const { handleMock, removeHandlerMock, getPathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const { provisionMock } = vi.hoisted(() => ({ provisionMock: vi.fn() }))
vi.mock('../worktree-services', () => ({
  getWorktreeServicesRuntime: vi.fn(),
  loadServiceRecipesForWorktree: vi.fn(() => []),
  provisionWorktreeServices: provisionMock,
  runWorktreeServiceAction: vi.fn()
}))

import { registerWorktreeServicesHandlers } from './worktree-services'
import { upsertWorktreeServicesRecord } from '../../shared/worktree-services-store'
import type { WorktreeServicesRecord } from '../../shared/worktree-services'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-svc-ipc-'))
  handlers.clear()
  handleMock.mockReset()
  removeHandlerMock.mockReset()
  getPathMock.mockReset()
  getPathMock.mockReturnValue(dir)
  handleMock.mockImplementation((channel: string, fn: never) => {
    handlers.set(channel, fn as never)
  })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function record(worktreeId: string): WorktreeServicesRecord {
  return {
    worktreeId,
    repoId: 'repo-1',
    slot: 0,
    slug: 'wt-s0',
    serviceIds: ['db'],
    env: { ORCA_SERVICE_SLOT: '0' },
    status: 'ready',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z'
  }
}

const store = { getRepo: vi.fn(), getWorktreeMeta: vi.fn() } as never

describe('registerWorktreeServicesHandlers', () => {
  it('registers list and retry handlers', () => {
    registerWorktreeServicesHandlers(store)
    expect(handlers.has('worktreeServices:list')).toBe(true)
    expect(handlers.has('worktreeServices:retry')).toBe(true)
  })

  it('list returns records from the store', async () => {
    upsertWorktreeServicesRecord(dir, record('wt-1'))
    registerWorktreeServicesHandlers(store)
    const list = handlers.get('worktreeServices:list')!
    const result = await list({}, undefined as never)
    expect(result).toEqual([record('wt-1')])
  })

  it('joins concurrent retries for the same worktree instead of double-provisioning', async () => {
    const repoStore = {
      getRepo: vi.fn(() => ({ id: 'repo-1', path: '/tmp/repo' })),
      getWorktreeMeta: vi.fn(() => undefined)
    } as never
    let release: ((value: WorktreeServicesRecord) => void) | undefined
    provisionMock.mockImplementation(
      () =>
        new Promise<WorktreeServicesRecord>((resolve) => {
          release = resolve
        })
    )
    registerWorktreeServicesHandlers(repoStore)
    const retry = handlers.get('worktreeServices:retry')!
    const event = { sender: { send: vi.fn() } }
    const worktreeId = 'repo-1::/tmp/wt'
    const first = retry(event, { worktreeId } as never)
    const second = retry(event, { worktreeId } as never)
    release!(record(worktreeId))
    const [a, b] = await Promise.all([first, second])
    expect(provisionMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })
})
