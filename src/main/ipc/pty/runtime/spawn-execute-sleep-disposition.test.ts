import { describe, expect, it, vi } from 'vitest'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { executeRuntimePtySpawn } from './spawn-execute'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'

function spawnCtx(leaveWorktreeSleeping: boolean) {
  const acquireWorktreeTerminalSpawn = vi.fn(async () => {
    throw new Error('stop-after-acquire')
  })
  const deps = {
    runtime: { acquireWorktreeTerminalSpawn },
    store: undefined,
    options: {}
  } as unknown as PtyRuntimeControllerDeps
  const args = {
    cols: 80,
    rows: 24,
    worktreeId: 'wt-1',
    ...(leaveWorktreeSleeping ? { leaveWorktreeSleeping: true } : {})
  } satisfies RuntimePtySpawnArgs
  return { ctx: createRuntimePtySpawnState(deps, args), acquireWorktreeTerminalSpawn }
}

describe('runtime spawn sleep disposition', () => {
  it('asks an automatic recovery to leave a committed host sleep', async () => {
    const { ctx, acquireWorktreeTerminalSpawn } = spawnCtx(true)
    await expect(executeRuntimePtySpawn(ctx)).rejects.toThrow('stop-after-acquire')
    expect(acquireWorktreeTerminalSpawn).toHaveBeenCalledWith('wt-1', 'leave')
  })

  it('wakes a committed host sleep for an explicit spawn', async () => {
    const { ctx, acquireWorktreeTerminalSpawn } = spawnCtx(false)
    await expect(executeRuntimePtySpawn(ctx)).rejects.toThrow('stop-after-acquire')
    expect(acquireWorktreeTerminalSpawn).toHaveBeenCalledWith('wt-1', 'wake')
  })
})
