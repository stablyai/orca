import type { ChildProcess } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findSelfInitiatedTreeKills,
  resetSelfInitiatedTreeKillLogForTest
} from '../crash-reporting/self-initiated-tree-kill-log'
import type { DescendantSnapshot, ProcessTableRow } from '../pty-descendant-termination'
import { killSupervisedProviderGroup } from './provider-supervised-group-kill'

const SUPERVISOR = 1_000
const PROVIDER = 1_001

function supervisor(alive = true) {
  return { kill: vi.fn<ChildProcess['kill']>(() => alive) }
}

function row(pid: number, ppid: number, pgid: number): ProcessTableRow {
  return { pid, ppid, pgid, startedAt: 'Mon Oct  5 10:00:00 2026' }
}

/** The supervisor leads its own group; the provider leads another, with a tool in it. */
function walk(descendants: ProcessTableRow[] = providerTree()): DescendantSnapshot {
  return {
    root: { pid: SUPERVISOR, startedAt: 'Mon Oct  5 09:59:00 2026' },
    rootPgid: SUPERVISOR,
    descendants,
    capturedAtMs: 1
  }
}

function providerTree(): ProcessTableRow[] {
  return [row(PROVIDER, SUPERVISOR, PROVIDER), row(1_002, PROVIDER, PROVIDER)]
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

function signals(target: ReturnType<typeof supervisor>): unknown[] {
  return target.kill.mock.calls.map(([signal]) => signal)
}

describe('killSupervisedProviderGroup', () => {
  beforeEach(() => {
    resetSelfInitiatedTreeKillLogForTest()
  })

  it("kills the provider's own group while the supervisor is paused, then the supervisor", async () => {
    const target = supervisor()
    const order: string[] = []
    target.kill.mockImplementation((signal) => {
      order.push(`supervisor ${String(signal)}`)
      return true
    })
    const signalProcessGroup = vi.fn((pgid: number, signal: NodeJS.Signals) => {
      order.push(`group ${pgid} ${signal}`)
    })

    const result = await killSupervisedProviderGroup(target, SUPERVISOR, {
      site: 'test-teardown',
      captureDescendants: async () => walk(),
      signalProcessGroup
    })

    expect(result.provider).toBe('killed')
    expect(order).toEqual(['supervisor SIGSTOP', `group ${PROVIDER} SIGKILL`, 'supervisor SIGKILL'])
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([
      expect.objectContaining({
        pid: PROVIDER,
        site: 'test-teardown',
        scope: 'posix-process-group'
      })
    ])
  })

  it.each([
    ['ESRCH', 'an empty group'],
    ['EPERM', 'a group of zombies on macOS']
  ])('reads %s (%s) as nothing left to run, and still kills the supervisor', async (code) => {
    const target = supervisor()

    const result = await killSupervisedProviderGroup(target, SUPERVISOR, {
      site: 'test-teardown',
      captureDescendants: async () => walk(),
      signalProcessGroup: () => {
        throw errno(code)
      }
    })

    expect(result.provider).toBe('gone')
    expect(signals(target)).toEqual(['SIGSTOP', 'SIGKILL'])
    // Nothing here killed it, so there is no kill to report as Orca's.
    expect(findSelfInitiatedTreeKills(Date.now())).toEqual([])
  })

  it('resumes the supervisor, killing nothing, when the group signal fails for another reason', async () => {
    const target = supervisor()

    const result = await killSupervisedProviderGroup(target, SUPERVISOR, {
      site: 'test-teardown',
      captureDescendants: async () => walk(),
      signalProcessGroup: () => {
        throw errno('EINVAL')
      }
    })

    expect(result.provider).toBe('unknown')
    expect(signals(target)).toEqual(['SIGSTOP', 'SIGCONT'])
  })

  it.each([
    ['the process table cannot be read', async () => null],
    [
      'the read fails',
      async () => {
        throw new Error('ps timed out')
      }
    ],
    [
      'the walk did not see the supervisor',
      async (): Promise<DescendantSnapshot> => ({
        rootPgid: null,
        descendants: [],
        capturedAtMs: 1
      })
    ],
    [
      'two children claim to lead their own group',
      async () => walk([...providerTree(), row(1_003, SUPERVISOR, 1_003)])
    ]
  ])(
    'never kills the supervisor without the group kill when %s',
    async (_situation, captureDescendants) => {
      const target = supervisor()
      const signalProcessGroup = vi.fn()

      const result = await killSupervisedProviderGroup(target, SUPERVISOR, {
        site: 'test-teardown',
        captureDescendants,
        signalProcessGroup
      })

      expect(result.provider).toBe('unknown')
      expect(signalProcessGroup).not.toHaveBeenCalled()
      // Resumed, the supervisor's own stop still reaches the provider's group.
      expect(signals(target)).toEqual(['SIGSTOP', 'SIGCONT'])
    }
  )

  it('reads a paused supervisor with no provider child as the provider already reaped', async () => {
    const target = supervisor()
    const signalProcessGroup = vi.fn()

    const result = await killSupervisedProviderGroup(target, SUPERVISOR, {
      site: 'test-teardown',
      // A grandchild leading its own group is not the supervisor's provider.
      captureDescendants: async () => walk([row(1_005, 1_004, 1_005)]),
      signalProcessGroup
    })

    expect(result.provider).toBe('gone')
    expect(signalProcessGroup).not.toHaveBeenCalled()
    // It is clearing the rest of its group; killing it now could orphan what is left there.
    expect(signals(target)).toEqual(['SIGSTOP', 'SIGCONT'])
  })

  it('does nothing more once the supervisor has exited', async () => {
    const target = supervisor(false)
    const captureDescendants = vi.fn()

    const result = await killSupervisedProviderGroup(target, SUPERVISOR, {
      site: 'test-teardown',
      captureDescendants
    })

    expect(result).toEqual({ provider: 'unknown', snapshot: null })
    expect(captureDescendants).not.toHaveBeenCalled()
    expect(signals(target)).toEqual(['SIGSTOP'])
  })
})
