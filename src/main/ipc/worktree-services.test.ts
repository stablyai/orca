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
})
