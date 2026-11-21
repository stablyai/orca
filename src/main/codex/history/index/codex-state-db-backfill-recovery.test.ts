import { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gateMocks = vi.hoisted(() => ({ noteWslDistroMayHaveStopped: vi.fn() }))
vi.mock('../../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...gateMocks
}))

import { runCodexStateDbBackfillRecovery } from './codex-state-db-backfill-recovery'
import type { CodexBackfillRecoveryChild } from './codex-state-db-backfill-recovery-process'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function recoveryRig(blockedAnswers: boolean[]) {
  const children: CodexBackfillRecoveryChild[] = []
  const deps = {
    spawnProcess: vi.fn(() => {
      const child = new ChildProcess()
      children.push(child)
      return child
    }),
    resolveCommand: () => 'codex',
    readStatus: vi.fn(() => ({
      kind: 'incomplete' as const,
      stateDbPath: '/state.sqlite',
      status: 'running'
    })),
    countSessions: () => 0,
    now: Date.now,
    // `wsl --shutdown` kills the running child while recovery waits between status reads.
    sleep: vi.fn(async () => {
      children.at(-1)?.emit('exit', 1, null)
    }),
    terminate: vi.fn(async (child: CodexBackfillRecoveryChild) => {
      child.emit('exit', null, 'SIGTERM')
    }),
    isDistroBlocked: vi.fn(async () => blockedAnswers.shift() ?? true)
  }
  return deps
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.clearAllMocks()
})

describe('runCodexStateDbBackfillRecovery for a WSL home (E9)', () => {
  it('ends as stopped instead of respawning into a distro that stopped under its child', async () => {
    const deps = recoveryRig([false, false])

    await expect(
      runCodexStateDbBackfillRecovery(WSL_HOME, new AbortController().signal, deps)
    ).resolves.toEqual({ outcome: 'stopped', spawnCount: 1 })

    expect(deps.spawnProcess).toHaveBeenCalledTimes(1)
    // Only the initial read: the post-exit read would have gone over `\\wsl.localhost`.
    expect(deps.readStatus).toHaveBeenCalledTimes(1)
    // The child's own exit voids the running lease, so the refusing read was fresh.
    expect(gateMocks.noteWslDistroMayHaveStopped).toHaveBeenCalledWith('Ubuntu')
  })

  it('touches nothing in a distro that is already stopped', async () => {
    const deps = recoveryRig([true])

    await expect(
      runCodexStateDbBackfillRecovery(WSL_HOME, new AbortController().signal, deps)
    ).resolves.toEqual({ outcome: 'stopped', spawnCount: 0 })

    expect(deps.readStatus).not.toHaveBeenCalled()
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })
})
