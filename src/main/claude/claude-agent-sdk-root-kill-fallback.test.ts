import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type { SpawnedProcess } from '@orca/process-host/process-spec'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

const ROOT_PID = 424242
const ROOT_STARTED_AT = 'Mon Jan 1 00:00:00 2026'
const ROOT_FORK_MS = Date.parse(ROOT_STARTED_AT)

function mockChild(): EventEmitter &
  Pick<SpawnedProcess, 'pid' | 'kill' | 'stdin'> & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    pid: ROOT_PID,
    stdin: new PassThrough(),
    kill: vi.fn(() => true)
  }) as never
}

function posixSnapshot(input: {
  capturedAtMs: number
  descendants?: DescendantSnapshot['descendants']
}): DescendantSnapshot {
  return {
    root: { pid: ROOT_PID, startedAt: ROOT_STARTED_AT },
    rootPgid: ROOT_PID,
    descendants: input.descendants ?? [],
    capturedAtMs: input.capturedAtMs
  }
}

describe('Claude descendant proof without independent root ownership', () => {
  it('keeps recycled descendant evidence unverifiable without signalling its root', async () => {
    const child = mockChild()
    const captureDescendants = vi
      .fn()
      .mockResolvedValueOnce(
        posixSnapshot({
          capturedAtMs: ROOT_FORK_MS + 5_000,
          descendants: [{ pid: 100, ppid: ROOT_PID, pgid: ROOT_PID, startedAt: ROOT_STARTED_AT }]
        })
      )
      .mockResolvedValueOnce(
        posixSnapshot({
          capturedAtMs: ROOT_FORK_MS + 6_000,
          descendants: [
            { pid: 100, ppid: ROOT_PID, pgid: ROOT_PID, startedAt: 'Mon Jan 1 00:00:30 2026' }
          ]
        })
      )
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => false,
      captureDescendants,
      terminateDescendants: vi.fn(async () => 'exited' as const)
    })

    await tree.capture()
    await tree.refresh?.()
    // The discarded evidence grants no independent root authority.
    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps an observed live descendant independent of root termination', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => false,
      captureDescendants: vi.fn(async () =>
        posixSnapshot({
          capturedAtMs: ROOT_FORK_MS + 5_000,
          descendants: [{ pid: 100, ppid: ROOT_PID, pgid: ROOT_PID, startedAt: ROOT_STARTED_AT }]
        })
      ),
      terminateDescendants: vi.fn(async () => 'live' as const)
    })

    await expect(tree.reap()).resolves.toBe('live')
    expect(tree.treeVerdict).toBe('live')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps an unreadable POSIX snapshot unverifiable without signalling its root', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => false,
      captureDescendants: vi.fn(async () => null),
      terminateDescendants: vi.fn()
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('never signals a root the reaper already saw exit', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => true,
      captureDescendants: vi.fn(async () => null)
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(child.kill).not.toHaveBeenCalled()
  })
})
