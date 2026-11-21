import { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackfillDistroState } from './codex-backfill-wsl-gate'
import type { CodexStateDbBackfillStatus } from './codex-state-db'

const gateMocks = vi.hoisted(() => ({ noteWslDistroMayHaveStopped: vi.fn() }))
vi.mock('../../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...gateMocks
}))

import {
  _internals,
  runCodexStateDbBackfillRecovery,
  startCodexStateDbBackfillRecoveryInBackground
} from './codex-state-db-backfill-recovery'
import type { CodexBackfillRecoveryChild } from './codex-state-db-backfill-recovery-process'

const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex'
const INCOMPLETE: CodexStateDbBackfillStatus = {
  kind: 'incomplete',
  stateDbPath: '/state.sqlite',
  status: 'running'
}
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function recoveryRig(
  states: BackfillDistroState[],
  options: { childDiesOnSleep?: boolean; statuses?: CodexStateDbBackfillStatus[] } = {}
) {
  const children: CodexBackfillRecoveryChild[] = []
  const statuses = options.statuses ?? []
  return {
    spawnProcess: vi.fn(() => {
      const child = new ChildProcess()
      children.push(child)
      return child
    }),
    resolveCommand: () => 'codex',
    readStatus: vi.fn(() => statuses.shift() ?? INCOMPLETE),
    countSessions: () => 0,
    now: Date.now,
    // With childDiesOnSleep, `wsl --shutdown` kills the child while recovery waits between reads.
    sleep: vi.fn(async () => {
      if (options.childDiesOnSleep) {
        children.at(-1)?.emit('exit', 1, null)
      }
    }),
    terminate: vi.fn(async (child: CodexBackfillRecoveryChild) => {
      child.emit('exit', null, 'SIGTERM')
    }),
    distroState: vi.fn(async (): Promise<BackfillDistroState> => states.shift() ?? 'stopped')
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  _internals.resetForTests()
  vi.clearAllMocks()
})

describe('runCodexStateDbBackfillRecovery for a WSL home (E9)', () => {
  it('ends as stopped instead of respawning into a distro that stopped under its child', async () => {
    const deps = recoveryRig(['running', 'running'], { childDiesOnSleep: true })

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
    const deps = recoveryRig(['stopped'])

    await expect(
      runCodexStateDbBackfillRecovery(WSL_HOME, new AbortController().signal, deps)
    ).resolves.toEqual({ outcome: 'stopped', spawnCount: 0 })

    expect(deps.readStatus).not.toHaveBeenCalled()
    expect(deps.spawnProcess).not.toHaveBeenCalled()
  })

  it('keeps a live child through an unverifiable read, without reading, and never notes its own stop', async () => {
    const deps = recoveryRig(['running', 'running', 'unverifiable', 'running'], {
      statuses: [INCOMPLETE, { kind: 'complete', stateDbPath: '/state.sqlite' }]
    })

    await expect(
      runCodexStateDbBackfillRecovery(WSL_HOME, new AbortController().signal, deps)
    ).resolves.toEqual({ outcome: 'completed', spawnCount: 1 })

    expect(deps.terminate).toHaveBeenCalledTimes(1)
    expect(deps.readStatus).toHaveBeenCalledTimes(2)
    expect(gateMocks.noteWslDistroMayHaveStopped).not.toHaveBeenCalled()
  })
})

describe('startCodexStateDbBackfillRecoveryInBackground for a WSL home (E9)', () => {
  it('does not read the state DB over UNC while the gate refuses', async () => {
    const isPending = vi.fn(() => true)

    await expect(
      startCodexStateDbBackfillRecoveryInBackground(WSL_HOME, {
        isDistroBlocked: async () => true,
        isPending
      })
    ).resolves.toBeNull()

    expect(isPending).not.toHaveBeenCalled()
  })
})
