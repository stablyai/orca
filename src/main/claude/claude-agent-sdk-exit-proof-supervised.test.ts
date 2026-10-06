// The Claude reaper's forced step, per platform: on POSIX the root is the provider supervisor and
// Claude leads a group of its own; on Windows the root is Claude.

import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { WindowsDescendantSnapshot } from '../windows-descendant-exit-verification'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

const SUPERVISOR = 424_242
const CLAUDE = 424_243

/** The supervisor's walk: Claude leads its own group, with one tool in it. */
function supervisorWalk(): DescendantSnapshot {
  const started = 'Mon Jan 1 00:00:00 2026'
  return {
    root: { pid: SUPERVISOR, startedAt: started },
    rootPgid: SUPERVISOR,
    descendants: [
      { pid: CLAUDE, ppid: SUPERVISOR, pgid: CLAUDE, startedAt: started },
      { pid: CLAUDE + 1, ppid: CLAUDE, pgid: CLAUDE, startedAt: started }
    ],
    capturedAtMs: 1
  }
}

function root(kills: string[], delivered = true) {
  return {
    pid: SUPERVISOR,
    kill: vi.fn<ChildProcess['kill']>((signal) => {
      kills.push(`root ${String(signal)}`)
      return delivered
    })
  }
}

describe('claude reaper forced step on a supervised POSIX root', () => {
  it("kills Claude's own group before the supervisor, then verifies the rest of the tree", async () => {
    const kills: string[] = []
    const verify = Promise.withResolvers<DescendantTreeVerdict>()
    const terminateDescendants = vi.fn(() => {
      kills.push('verify')
      return verify.promise
    })
    const tree = createClaudeChildTreeReaper(root(kills), {
      platform: 'darwin',
      supervised: true,
      captureDescendants: async () => supervisorWalk(),
      terminateDescendants,
      signalProcessGroup: (pgid, signal) => kills.push(`group ${pgid} ${signal}`)
    })

    const reaped = tree.reap()
    await vi.waitFor(() => expect(terminateDescendants).toHaveBeenCalled())
    expect(tree.providerKilled).toBe(true)
    verify.resolve('exited')

    await expect(reaped).resolves.toBe('exited')
    expect(kills).toEqual(['root SIGSTOP', `group ${CLAUDE} SIGKILL`, 'root SIGKILL', 'verify'])
  })

  // Before: no snapshot meant a SIGKILL to the supervisor alone, orphaning Claude in its own group
  // with nobody left to stop it, and the root's exit then read as Claude gone.
  it('never kills the supervisor alone when the process table cannot be read', async () => {
    const kills: string[] = []
    const signalProcessGroup = vi.fn()
    const tree = createClaudeChildTreeReaper(root(kills), {
      platform: 'linux',
      supervised: true,
      captureDescendants: async () => null,
      signalProcessGroup
    })

    await expect(tree.reap()).resolves.toBe('unverifiable')
    expect(kills).toEqual(['root SIGSTOP', 'root SIGCONT'])
    expect(signalProcessGroup).not.toHaveBeenCalled()
    expect(tree.providerKilled).toBe(false)
  })

  it('signals nothing once the supervised root has exited, and only verifies the tree', async () => {
    const kills: string[] = []
    let exited = false
    const terminateDescendants = vi.fn(async () => 'exited' as const)
    const tree = createClaudeChildTreeReaper(root(kills), {
      platform: 'darwin',
      supervised: true,
      exited: () => exited,
      captureDescendants: async () => supervisorWalk(),
      terminateDescendants
    })
    await tree.capture()
    exited = true

    await expect(tree.reap()).resolves.toBe('exited')
    expect(kills).toEqual([])
    expect(tree.providerKilled).toBe(false)
  })
})

describe('claude reaper forced step on Windows, where the root is Claude', () => {
  function windowsWalk(): WindowsDescendantSnapshot {
    return {
      root: { pid: SUPERVISOR, creationTimeMs: 1_700_000_000_001 },
      descendants: [],
      unidentifiedCount: 0,
      capturedAtMs: 1
    }
  }

  it.each([
    [true, 'delivered'],
    [false, 'not delivered']
  ])('reads providerKilled=%s from a TerminateProcess %s', async (delivered) => {
    const kills: string[] = []
    const tree = createClaudeChildTreeReaper(root(kills, delivered), {
      platform: 'win32',
      verifyRootIdentity: async () => true,
      captureWindowsDescendants: async () => windowsWalk(),
      terminateWindowsTree: async () => undefined,
      terminateWindowsDescendants: async () => 'exited'
    })

    await tree.reap()
    expect(kills).toEqual(['root SIGKILL'])
    expect(tree.providerKilled).toBe(delivered)
  })
})
