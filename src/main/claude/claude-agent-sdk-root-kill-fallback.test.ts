import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnedProcess } from '../../shared/child-process/run-process'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'
import { mergeClaudeCapturedTrees } from './claude-child-tree-snapshot'

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

function windowsSnapshot(capturedAtMs = 1): WindowsDescendantSnapshot {
  return {
    root: { pid: ROOT_PID, creationTimeMs: 1_700_000_000_001 },
    descendants: [{ pid: 4243, creationTimeMs: 1_700_000_000_000 }],
    unidentifiedCount: 0,
    capturedAtMs
  }
}

describe('Claude root kill fallback', () => {
  it('kills the root when the first capture landed in the fork second', async () => {
    // The production POSIX verifier declines a root born in its capture second,
    // and that verdict must not cost the tree the kill on Node's own handle.
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => false,
      captureDescendants: vi.fn(async () => posixSnapshot({ capturedAtMs: ROOT_FORK_MS + 300 }))
    })

    await expect(tree.reap()).resolves.toBe('exited')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the root after a recycled descendant pid voided the snapshot', async () => {
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
      terminateDescendants: vi.fn(async () => 'exited' as const),
      verifyRootIdentity: vi.fn(async () => true)
    })

    await tree.capture()
    await tree.refresh?.()
    // The descendant evidence is rightly discarded; the root's never was in doubt.
    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('keeps an observed live descendant when the root identity probe declined', async () => {
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
      terminateDescendants: vi.fn(async () => 'live' as const),
      verifyRootIdentity: vi.fn(async () => false)
    })

    await expect(tree.reap()).resolves.toBe('live')
    expect(tree.treeVerdict).toBe('live')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('reports a Windows taskkill that worked as exited, not unverifiable', async () => {
    const child = mockChild()
    // Probe 1 gates taskkill; a later probe correctly finds the root already dead.
    const verifyRootIdentity = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      exited: () => false,
      captureWindowsDescendants: vi.fn(async () => windowsSnapshot()),
      terminateWindowsTree: vi.fn(async () => {}),
      terminateWindowsDescendants: vi.fn(async () => 'exited' as const),
      verifyRootIdentity
    })

    await expect(tree.reap()).resolves.toBe('exited')
  })

  it('kills the root when no POSIX snapshot could be read', async () => {
    const child = mockChild()
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'linux',
      exited: () => false,
      captureDescendants: vi.fn(async () => null),
      terminateDescendants: vi.fn()
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the root when the Windows process table is unreadable', async () => {
    const child = mockChild()
    const terminateWindowsTree = vi.fn(async () => {})
    const tree = createClaudeChildTreeReaper(child, {
      platform: 'win32',
      exited: () => false,
      captureWindowsDescendants: vi.fn(async () => null),
      terminateWindowsTree,
      terminateWindowsDescendants: vi.fn()
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    // No identity means no bare-pid tree kill, but the owned handle is still ours.
    expect(terminateWindowsTree).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
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

  it('chains per-pid Windows boundaries across a second merge', async () => {
    const first = windowsSnapshot(1_000)
    const second: WindowsDescendantSnapshot = {
      ...windowsSnapshot(2_000),
      descendants: [
        { pid: 4243, creationTimeMs: 1_700_000_000_000 },
        { pid: 4244, creationTimeMs: 1_700_000_000_002 }
      ]
    }
    const third: WindowsDescendantSnapshot = { ...second, capturedAtMs: 3_000 }

    const merged = mergeClaudeCapturedTrees(
      { platform: 'win32', tree: first },
      { platform: 'win32', tree: second }
    )
    expect(merged?.tree.capturedAtMsByPid).toEqual({ '4243': 1_000, '4244': 2_000 })
    const rechained = mergeClaudeCapturedTrees(merged!, { platform: 'win32', tree: third })

    expect(rechained?.tree.capturedAtMsByPid).toEqual({ '4243': 1_000, '4244': 2_000 })
  })
})
