// #9819, the client half: what the sweep actually asks the store and the host, and what it does
// with the answers. The rule itself is covered in ssh-relay-pty-ownership-proof.test.ts.
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { ForegroundProcessEvidence } from '../../shared/foreground-process-evidence'
import type { PersistedState } from '../../shared/persisted-state-types'
import {
  upsertSshRemotePtyLease,
  type SshPtyLeaseOperations
} from '../persistence/leasing-ssh-ptys/ssh-pty-lease-operations'
import {
  RELAY_PTY_SWEEP_PASS_BUDGET_MS,
  sweepOrphanedRelayPtys
} from './ssh-orphan-relay-pty-sweep'
import { RELAY_PTY_SWEEP_MIN_AGE_MS } from '../../shared/ssh-relay-pty-ownership-proof'

const TARGET = 'target-1'
const OURS = 'client-instance-ours'
// A stable pane id is a UUID; anything else is stripped before supersede can match on it.
const LEAF = '11111111-2222-4333-8444-555555555555'

const OBSERVATION = { authorityGeneration: 'gen-1', observationEpoch: 1, capturedAgeMs: 0 }

/** The host looked and saw its own shell owning the terminal: nothing is running in the pane. */
function idleShell(): ForegroundProcessEvidence {
  return { ...OBSERVATION, verdict: 'live', processName: null, shellOwnsEveryTtyProcessGroup: true }
}

function hostEntry(overrides: Partial<PtyProcessInfo> = {}): PtyProcessInfo {
  return {
    id: `ssh:${TARGET}@@pty-1`,
    incarnationId: 'inc-1',
    cwd: '/home/user',
    title: 'zsh',
    ownerClientInstanceId: OURS,
    hostAgeMs: RELAY_PTY_SWEEP_MIN_AGE_MS * 2,
    paneBound: true,
    foregroundProcessEvidence: idleShell(),
    ...overrides
  }
}

function createHarness(
  processes: PtyProcessInfo[],
  leases: SshRemotePtyLease[] = []
): { provider: IPtyProvider; store: Store; shutdown: ReturnType<typeof vi.fn> } {
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const provider = {
    listProcesses: vi.fn().mockResolvedValue(processes),
    shutdown
  } as unknown as IPtyProvider
  const store = {
    getSshRemotePtyLeases: vi.fn().mockReturnValue(leases)
  } as unknown as Store
  return { provider, store, shutdown }
}

function run(
  harness: ReturnType<typeof createHarness>,
  overrides: Partial<Parameters<typeof sweepOrphanedRelayPtys>[0]> = {}
): Promise<void> {
  return sweepOrphanedRelayPtys({
    targetId: TARGET,
    store: harness.store,
    provider: harness.provider,
    clientInstanceId: OURS,
    isSessionOwner: true,
    routedPtyIds: [],
    shouldContinue: () => true,
    ...overrides
  })
}

function lease(ptyId: string, state: SshRemotePtyLease['state']): SshRemotePtyLease {
  return { ptyId, state } as SshRemotePtyLease
}

describe('sweepOrphanedRelayPtys', () => {
  it('stops an attested orphan, fenced on the incarnation the same listing published', async () => {
    const harness = createHarness([hostEntry()])

    await run(harness)

    expect(harness.shutdown).toHaveBeenCalledWith(
      `ssh:${TARGET}@@pty-1`,
      expect.objectContaining({ immediate: true, expectedIncarnationId: 'inc-1' })
    )
  })

  it('asks the host to re-check ownership on the one call that cannot be undone', async () => {
    // The stop is the only irreversible step in this flow, and until now the whole nine-condition
    // rule was enforced only here, on the client that decided to make it. Naming the owner makes
    // the host re-decide where the processes actually live.
    const harness = createHarness([hostEntry()])

    await run(harness)

    expect(harness.shutdown).toHaveBeenCalledWith(
      `ssh:${TARGET}@@pty-1`,
      expect.objectContaining({ expectedOwnerClientInstanceId: OURS })
    )
  })

  it('does not act on an observation that aged out between the listing and the plan', async () => {
    // The listing answered inside the budget, but this pass then spent longer than the evidence is
    // good for. Staleness has to degrade to "leave it running".
    let clock = 1_000_000
    const harness = createHarness([hostEntry()])
    harness.provider.listProcesses = vi.fn().mockImplementation(async () => {
      clock += 1
      return [hostEntry()]
    })

    const pass = (maximumEvidenceAgeMs: number): Promise<void> =>
      run(harness, {
        now: () => clock,
        maximumEvidenceAgeMs,
        passBudgetMs: 60_000,
        shouldContinue: () => {
          clock += 20
          return true
        }
      })

    await pass(10)
    expect(harness.shutdown).not.toHaveBeenCalled()

    // Positive control: the same entry, the same elapsed time, a budget that covers it.
    await pass(10_000)
    expect(harness.shutdown).toHaveBeenCalledTimes(1)
  })

  it('leaves a PTY the caller just reattached alone', async () => {
    const harness = createHarness([hostEntry()])

    await run(harness, { routedPtyIds: ['pty-1'] })

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it.each([['attached'], ['detached']] as const)(
    'leaves a PTY holding a live %s lease alone',
    async (state) => {
      const harness = createHarness([hostEntry()], [lease('pty-1', state)])

      await run(harness)

      expect(harness.shutdown).not.toHaveBeenCalled()
    }
  )

  it('leaves a PTY with an undelivered stop to the replay pass', async () => {
    // The kill-intent journal owns those: it re-fences and retries them, and a second stop issued
    // from here would race that decision with weaker evidence.
    const tombstoned = {
      ...lease('pty-1', 'terminated'),
      pendingKill: { requestedAt: 1, incarnationId: 'inc-1', attempts: 0 }
    } as SshRemotePtyLease
    const harness = createHarness([hostEntry()], [tombstoned])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('leaves a PTY whose lease this client expired alone', async () => {
    // The reversal this guards: supersedeSiblingLeasesForPane, dropStalePty and the missing-surface
    // refusal all write `expired` precisely BECAUSE they will not stop the remote process.
    const harness = createHarness([hostEntry()], [lease('pty-1', 'expired')])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('leaves a PTY whose expired lease names a recycled relay id alone', async () => {
    // `relayIdRecycled` is the one expired lease the reattach predicate refuses, so it is the case
    // most likely to be mistaken for a licence to kill. The sweep asks a different question: this
    // id now names some OTHER incarnation, which makes a stop more dangerous, not less.
    const harness = createHarness(
      [hostEntry()],
      [{ ...lease('pty-1', 'expired'), relayIdRecycled: true }]
    )

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('leaves alone a lease the real supersede path expired when a pane re-leased', async () => {
    // Drives the actual persistence operation rather than asserting the state by hand, so this
    // stays true only while supersede really does leave the predecessor's process running.
    const state: PersistedState = {
      sshRemotePtyLeases: [
        {
          targetId: TARGET,
          ptyId: 'pty-1',
          state: 'attached',
          worktreeId: 'wt-1',
          leafId: LEAF,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    } as unknown as PersistedState
    const operations: SshPtyLeaseOperations = {
      state,
      toStoredPtyId: (_targetId, ptyId) => ptyId,
      toComparablePtyId: (_targetId, ptyId) => ptyId,
      clearBindingsForTarget: () => {},
      clearBindingsForLeases: () => false,
      flush: () => {},
      flushDurableStateOrThrowAsync: async () => {}
    }
    // The same pane re-leases under a new relay id; pty-1 is expired, never terminated.
    upsertSshRemotePtyLease(operations, {
      targetId: TARGET,
      ptyId: 'pty-2',
      state: 'attached',
      worktreeId: 'wt-1',
      leafId: LEAF
    })
    expect(state.sshRemotePtyLeases?.find((entry) => entry.ptyId === 'pty-1')?.state).toBe(
      'expired'
    )
    const harness = createHarness([hostEntry()], state.sshRemotePtyLeases ?? [])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('forwards the host foreground observation, so a busy pane is never swept', async () => {
    // A `claude` the user launched by hand: Orca registered no agent session, so the entry carries
    // no agentSessionOwners and only the host's own observation can save it.
    const harness = createHarness([
      hostEntry({
        foregroundProcessEvidence: {
          ...OBSERVATION,
          verdict: 'live',
          processName: 'claude',
          shellOwnsEveryTtyProcessGroup: false
        }
      })
    ])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('bounds the listing and every stop with one connect budget', async () => {
    const harness = createHarness([hostEntry()])
    const start = 1_000_000

    await run(harness, { now: () => start })

    const deadline = vi.mocked(harness.provider.listProcesses).mock.calls[0]?.[0]?.deadlineMs
    expect(deadline).toBe(start + RELAY_PTY_SWEEP_PASS_BUDGET_MS)
    expect(harness.shutdown).toHaveBeenCalledWith(
      `ssh:${TARGET}@@pty-1`,
      expect.objectContaining({ deadlineMs: deadline })
    )
  })

  it('does sweep a PTY whose lease this client already tombstoned without an order', async () => {
    const harness = createHarness([hostEntry()], [lease('pty-1', 'terminated')])

    await run(harness)

    expect(harness.shutdown).toHaveBeenCalledTimes(1)
  })

  it('asks the host nothing when this connection is not the session owner', async () => {
    const harness = createHarness([hostEntry()])

    await run(harness, { isSessionOwner: false })

    expect(harness.provider.listProcesses).not.toHaveBeenCalled()
    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('stops nothing against a host that publishes no attestation', async () => {
    const legacy = hostEntry()
    delete legacy.ownerClientInstanceId
    delete legacy.hostAgeMs
    delete legacy.paneBound
    const harness = createHarness([legacy])

    await run(harness)

    expect(harness.shutdown).not.toHaveBeenCalled()
  })

  it('swallows a failed listing rather than failing the connect it runs on', async () => {
    const harness = createHarness([])
    vi.mocked(harness.provider.listProcesses).mockRejectedValue(new Error('relay went away'))

    await expect(run(harness)).resolves.toBeUndefined()
  })

  it('swallows a failed stop and leaves the order to the next connect', async () => {
    const harness = createHarness([hostEntry()])
    harness.shutdown.mockRejectedValue(new Error('connection lost'))

    await expect(run(harness)).resolves.toBeUndefined()
  })

  it('abandons the pass when the attempt is superseded mid-flight', async () => {
    const harness = createHarness([hostEntry()])
    let alive = true
    vi.mocked(harness.provider.listProcesses).mockImplementation(async () => {
      alive = false
      return [hostEntry()]
    })

    await run(harness, { shouldContinue: () => alive })

    expect(harness.shutdown).not.toHaveBeenCalled()
  })
})
