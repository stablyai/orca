import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/types'

// STA repro (silent-send incident): `orca terminal send` to a leaf whose ptyId
// no provider in this process owns was a silent no-op reported as success —
// the stale graph mirror answers writable=true and provider writes to unknown
// ids are accepted fire-and-forget. The leaf branch must reject ONLY on
// controller-proven absence; unknown liveness never rejects (a restored daemon
// session legitimately accepts writes before its pane remounts).

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const STALE_PTY_ID = 'pty-stale-from-prior-run'

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/probe-worktree',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

async function makeRuntimeWithLeafHandle(options: {
  leafPtyId?: string
  probePtyLiveness?: (ptyId: string) => Promise<boolean | null>
  hasPty?: (ptyId: string) => boolean | null
}): Promise<{
  runtime: OrcaRuntimeService
  handle: string
  write: ReturnType<typeof vi.fn>
}> {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const write = vi.fn(() => true)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () => []),
    ...(options.hasPty ? { hasPty: options.hasPty } : {}),
    ...(options.probePtyLiveness ? { probePtyLiveness: options.probePtyLiveness } : {})
  } as never)
  runtime.attachWindow(1)
  publishLeafGraph(runtime, options.leafPtyId ?? STALE_PTY_ID)
  const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
  return { runtime, handle: terminals[0].handle, write }
}

// Re-invocable: every graph resync replaces leaf records with fresh objects.
function publishLeafGraph(runtime: OrcaRuntimeService, leafPtyId: string): void {
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Codex',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: leafPtyId,
        paneTitle: null,
        title: ''
      }
    ]
  })
}

describe('sendTerminal absence gate for leaf-branch writes', () => {
  it('rejects only on controller-proven absence and never dispatches the write', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({ probePtyLiveness: probe })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).rejects.toThrow(
      'terminal_not_writable'
    )

    expect(probe).toHaveBeenCalledWith(STALE_PTY_ID)
    expect(write).not.toHaveBeenCalled()
  })

  it('gates agent prompt sends behind the same proven-absence check', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({ probePtyLiveness: probe })

    await expect(runtime.sendTerminalAgentPrompt(handle, 'do the thing')).rejects.toThrow(
      'terminal_not_writable'
    )

    expect(write).not.toHaveBeenCalled()
  })

  it('proceeds when the probe answers unknown (null) — unknown is not absence', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: async () => null
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      handle,
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('treats a throwing probe as unknown and proceeds', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: async () => {
        throw new Error('probe transport down')
      }
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('proceeds when the probe answers live (restored session before its pane remounts)', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: async () => true
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('proceeds unchanged when the controller exposes no probe', async () => {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({})

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('never probes when the provider synchronously knows the id (live pty)', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: probe,
      hasPty: (ptyId) => ptyId === STALE_PTY_ID
    })

    await expect(runtime.sendTerminal(handle, { text: 'ping' })).resolves.toMatchObject({
      accepted: true
    })

    expect(probe).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'ping')
  })

  it('reuses a proven-absent verdict across repeated sends instead of re-probing', async () => {
    const probe = vi.fn(async () => false)
    const { runtime, handle } = await makeRuntimeWithLeafHandle({ probePtyLiveness: probe })

    await expect(runtime.sendTerminal(handle, { text: 'a' })).rejects.toThrow(
      'terminal_not_writable'
    )
    await expect(runtime.sendTerminal(handle, { text: 'b' })).rejects.toThrow(
      'terminal_not_writable'
    )

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('drops the cached absent verdict once the provider re-learns the id', async () => {
    const probe = vi.fn(async () => false)
    const livePtyIds = new Set<string>()
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle({
      probePtyLiveness: probe,
      hasPty: (ptyId) => livePtyIds.has(ptyId)
    })

    await expect(runtime.sendTerminal(handle, { text: 'a' })).rejects.toThrow(
      'terminal_not_writable'
    )
    // Same id recreated by a fresh spawn: provider knowledge must beat the verdict.
    livePtyIds.add(STALE_PTY_ID)

    await expect(runtime.sendTerminal(handle, { text: 'b' })).resolves.toMatchObject({
      accepted: true
    })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, 'b')
  })
})

type StoredMessageRow = {
  id: string
  run_id: string
  from_handle: string
  to_handle: string
  subject: string
  body: string
  type: string
  priority: string
  thread_id: string | null
  payload: string | null
  read: number
  sequence: number
  created_at: string
  delivered_at: string | null
  sender_pane_key: null
}

function makeOrchestrationDbStub(toHandle: () => string) {
  const rows: StoredMessageRow[] = []
  const markAsDelivered = vi.fn((ids: string[]) => {
    for (const row of rows) {
      if (ids.includes(row.id)) {
        row.delivered_at = 'now'
      }
    }
  })
  return {
    rows,
    markAsDelivered,
    insert(subject: string, type: StoredMessageRow['type'] = 'status'): void {
      rows.push({
        id: `msg_${rows.length + 1}`,
        run_id: 'run_test',
        from_handle: 'term_sender',
        to_handle: toHandle(),
        subject,
        body: '',
        type,
        priority: 'normal',
        thread_id: null,
        payload: null,
        read: 0,
        sequence: rows.length + 1,
        created_at: 'now',
        delivered_at: null,
        sender_pane_key: null
      })
    },
    db: {
      // Mirrors the real query: `read = 0 AND delivered_at IS NULL`.
      getUndeliveredUnreadMessages: (handle: string) =>
        rows.filter((row) => row.to_handle === handle && row.read === 0 && !row.delivered_at),
      getActiveCoordinatorRun: () => null,
      // Consulted by onPtyExit's dispatch-failure path.
      getActiveDispatchForTerminal: () => null,
      markAsDelivered,
      close: () => {}
    }
  }
}

describe('push-on-idle orchestration delivery absence gate', () => {
  async function makeIdleLeafWithoutPtyRecord(options: {
    probePtyLiveness: (ptyId: string) => Promise<boolean | null>
    hasPty?: (ptyId: string) => boolean | null
  }) {
    const { runtime, handle, write } = await makeRuntimeWithLeafHandle(options)
    const stub = makeOrchestrationDbStub(() => handle)
    runtime.setOrchestrationDb(stub.db as never)
    // Title transitions mark the leaf idle; without a hasPty answering true the
    // provider never knew this id, modeling a leaf restored from a prior process.
    runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex working\x07', 100)
    runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex done\x07', 101)
    return { runtime, handle, write, stub }
  }

  // Why: the gate that authorizes a push runs BEFORE the probe defers, so a
  // same-id cold restore inside the probe window would otherwise be written to on
  // the dead process's authority — ptyId is exactly what a same-id respawn keeps.
  it('re-applies the live-idle gate when the probe answers after a same-id respawn', async () => {
    let resolveProbe!: (value: boolean | null) => void
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: () =>
        new Promise<boolean | null>((resolve) => {
          resolveProbe = resolve
        })
    })
    stub.insert('for the old session')

    runtime.notifyMessageArrived(handle, 'status')
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()

    // The session dies and cold-restores under the same id while the probe is out.
    runtime.onPtyExit(STALE_PTY_ID, 0)
    runtime.onPtySpawned(STALE_PTY_ID, undefined, { awaitsRegistration: false })

    resolveProbe(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(write).not.toHaveBeenCalled()
    expect(stub.rows[0].delivered_at).toBeNull()

    // The replacement's own live idle frame releases the row — through a fresh
    // probe, since this leaf's pty is still unknown to the provider.
    runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex done\x07', 200)
    resolveProbe(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(write).toHaveBeenCalledWith(
      STALE_PTY_ID,
      expect.stringContaining('Subject: for the old session')
    )
  })

  // Why: a `remote:` pty answers probePtyLiveness with null before its first
  // await (ipc/pty.ts), so the probe settles on a pure microtask chain. Without a
  // macrotask hop the continuation runs BEFORE the resumption of a check resolved
  // in the meantime — the waiter is already out of the map and its rows are not
  // yet read, so the push injects exactly what that check is about to return.
  it('waits a macrotask before delivering so a resolved check consumes its rows first', async () => {
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: async () => null
    })

    const pulled: string[] = []
    const checkResumed = runtime
      .waitForMessage(handle, { typeFilter: ['worker_done'], timeoutMs: 60_000 })
      .then(() => {
        for (const row of stub.rows) {
          if (row.type === 'worker_done' && row.read === 0) {
            row.read = 1
            pulled.push(row.subject)
          }
        }
      })

    stub.insert('unclaimed status')
    runtime.notifyMessageArrived(handle, 'status')
    // Land the completion while the probe chain is mid-flight — the slot where
    // the continuation would otherwise overtake the check's resumption.
    await Promise.resolve()
    await Promise.resolve()
    stub.insert('worker completion', 'worker_done')
    runtime.notifyMessageArrived(handle, 'worker_done')

    await checkResumed
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pulled).toEqual(['worker completion'])
    const payloads = write.mock.calls
      .map(([, data]) => data)
      .filter((data): data is string => typeof data === 'string')
    expect(payloads.some((data) => data.includes('Subject: unclaimed status'))).toBe(true)
    expect(payloads.some((data) => data.includes('Subject: worker completion'))).toBe(false)
  })

  // Why: the notify-time reservation snapshot exists for a waiter resolved inside
  // one microtask drain. The probe continuation runs many macrotasks later, and
  // the probe dedup swallows every notify arriving meanwhile — so a reservation
  // carried in here would skip a row with nothing left to retry it (#12536 again).
  it('does not carry a stale waiter reservation into the probe continuation', async () => {
    let resolveProbe!: (value: boolean | null) => void
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: () =>
        new Promise<boolean | null>((resolve) => {
          resolveProbe = resolve
        })
    })

    const waitPromise = runtime.waitForMessage(handle, {
      typeFilter: ['worker_done'],
      timeoutMs: 60_000
    })
    stub.insert('unclaimed status')
    runtime.notifyMessageArrived(handle, 'status')
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()

    // The reserving waiter goes away, then its type finally arrives — and the
    // probe dedup drops this notify, so only the continuation can deliver it.
    runtime.cancelMessageWaiters(handle)
    await expect(waitPromise).resolves.toBe('cancelled')
    stub.insert('late completion', 'worker_done')
    runtime.notifyMessageArrived(handle, 'worker_done')
    await Promise.resolve()

    resolveProbe(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Why twice: the probe continuation yields a turn before delivering.
    await new Promise((resolve) => setTimeout(resolve, 0))

    const payloads = write.mock.calls
      .map(([, data]) => data)
      .filter((data): data is string => typeof data === 'string')
    expect(payloads.some((data) => data.includes('Subject: unclaimed status'))).toBe(true)
    expect(payloads.some((data) => data.includes('Subject: late completion'))).toBe(true)
  })

  it('keeps messages queued instead of marking a proven-absent pty delivered', async () => {
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: async () => false
    })
    stub.insert('lost forever?')

    runtime.deliverPendingMessagesForHandle(handle)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(write).not.toHaveBeenCalled()
    expect(stub.markAsDelivered).not.toHaveBeenCalled()
    expect(stub.rows[0].delivered_at).toBeNull()
  })

  it('still delivers on unknown liveness after the probe resolves', async () => {
    const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
      probePtyLiveness: async () => null
    })
    stub.insert('hello')

    runtime.deliverPendingMessagesForHandle(handle)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Why twice: the probe continuation yields a turn before delivering.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(write).toHaveBeenCalledWith(STALE_PTY_ID, expect.stringContaining('Subject: hello'))
  })

  // Why: delivered_at stamps only in the delayed-Enter callback, so the whole
  // write→settle span — not just the probe — must be single-flight; a trigger
  // landing inside the 500ms window would re-read the same un-stamped rows.
  it('delivers once across concurrent probe triggers and an in-window re-trigger, then flushes parked rows', async () => {
    vi.useFakeTimers()
    try {
      let resolveProbe!: (value: boolean | null) => void
      const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
        probePtyLiveness: () =>
          new Promise<boolean | null>((resolve) => {
            resolveProbe = resolve
          })
      })
      stub.insert('exactly once')

      runtime.deliverPendingMessagesForHandle(handle)
      runtime.deliverPendingMessagesForHandle(handle)
      runtime.deliverPendingMessagesForHandle(handle)
      resolveProbe(null)
      await vi.advanceTimersByTimeAsync(0)

      const firstSubjectWrites = () =>
        write.mock.calls.filter(
          ([, data]) => typeof data === 'string' && data.includes('Subject: exactly once')
        )
      expect(firstSubjectWrites()).toHaveLength(1)

      // Re-trigger INSIDE the 500ms Enter window: the first batch is written but
      // not yet stamped, so a fresh probe cycle would re-inject it. (On the
      // fixed code no new probe is armed — the trigger parks; resolveProbe then
      // re-resolves the settled first probe, a no-op.)
      stub.insert('second message')
      runtime.deliverPendingMessagesForHandle(handle)
      resolveProbe(null)
      await vi.advanceTimersByTimeAsync(0)
      expect(firstSubjectWrites()).toHaveLength(1)

      // Enter fires, delivered_at stamps, the flight settles, and the parked
      // trigger re-runs on its own — arming a fresh probe for the new row.
      await vi.advanceTimersByTimeAsync(500)
      resolveProbe(null)
      await vi.advanceTimersByTimeAsync(0)

      const secondSubjectWrites = write.mock.calls.filter(
        ([, data]) => typeof data === 'string' && data.includes('Subject: second message')
      )
      expect(secondSubjectWrites).toHaveLength(1)
      expect(firstSubjectWrites()).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      expect(stub.rows.every((row) => row.delivered_at !== null)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sync-path double-trigger inside the Enter window delivers the first batch once and parks the rest', async () => {
    vi.useFakeTimers()
    try {
      const probe = vi.fn(async () => null)
      const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
        probePtyLiveness: probe,
        // Provider knows the id: delivery takes the pure synchronous path.
        hasPty: (ptyId) => ptyId === STALE_PTY_ID
      })
      stub.insert('first')

      runtime.deliverPendingMessagesForHandle(handle)
      stub.insert('second')
      runtime.deliverPendingMessagesForHandle(handle)

      const firstSubjectWrites = () =>
        write.mock.calls.filter(
          ([, data]) => typeof data === 'string' && data.includes('Subject: first')
        )
      expect(firstSubjectWrites()).toHaveLength(1)
      expect(probe).not.toHaveBeenCalled()

      // Settle flushes the parked trigger; the second row delivers alone —
      // its batch must not re-contain the already-stamped first row.
      await vi.advanceTimersByTimeAsync(500)
      const secondOnlyWrites = write.mock.calls.filter(
        ([, data]) =>
          typeof data === 'string' &&
          data.includes('Subject: second') &&
          !data.includes('Subject: first')
      )
      expect(secondOnlyWrites).toHaveLength(1)
      expect(firstSubjectWrites()).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(500)
      expect(stub.rows.every((row) => row.delivered_at !== null)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: cold restore respawns under the SAME session id. An Enter armed for
  // the dead incarnation must not fire into the replacement — it would inject
  // \r and stamp rows the new session never received.
  it('retires an armed Enter when the pty exits and respawns under the same id inside the window', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
        probePtyLiveness: async () => null,
        hasPty: (ptyId) => ptyId === STALE_PTY_ID
      })
      stub.insert('for the old session')

      runtime.deliverPendingMessagesForHandle(handle)
      expect(write).toHaveBeenCalledTimes(1)

      runtime.onPtyExit(STALE_PTY_ID, 0)
      runtime.onPtySpawned(STALE_PTY_ID)

      await vi.advanceTimersByTimeAsync(500)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
      expect(stub.markAsDelivered).not.toHaveBeenCalled()
      expect(stub.rows[0].delivered_at).toBeNull()

      // The replacement's own delivery starts a fresh flight and completes —
      // but only once ITS live title proves idle; the dead session's live status
      // no longer authorizes a write into the new process.
      runtime.deliverPendingMessagesForHandle(handle)
      expect(
        write.mock.calls.filter(
          ([, data]) => typeof data === 'string' && data.includes('Subject: for the old session')
        )
      ).toHaveLength(1)
      runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex working\x07', 200)
      runtime.onPtyData(STALE_PTY_ID, '\x1b]0;Codex done\x07', 201)
      const payloadWrites = write.mock.calls.filter(
        ([, data]) => typeof data === 'string' && data.includes('Subject: for the old session')
      )
      expect(payloadWrites).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(500)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
      expect(stub.rows[0].delivered_at).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans all delivery state on exit without id reuse — no leak, no stray settle effects', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
        probePtyLiveness: async () => null,
        hasPty: (ptyId) => ptyId === STALE_PTY_ID
      })
      const internals = runtime as unknown as {
        messageDeliveryFlightsByPtyId: Map<string, unknown>
        parkedMessageRedeliveryLeavesByPtyId: Map<string, unknown>
      }
      stub.insert('first')
      runtime.deliverPendingMessagesForHandle(handle)
      stub.insert('second')
      runtime.deliverPendingMessagesForHandle(handle)
      expect(internals.messageDeliveryFlightsByPtyId.size).toBe(1)
      expect(internals.parkedMessageRedeliveryLeavesByPtyId.size).toBe(1)

      runtime.onPtyExit(STALE_PTY_ID, 0)
      expect(internals.messageDeliveryFlightsByPtyId.size).toBe(0)
      expect(internals.parkedMessageRedeliveryLeavesByPtyId.size).toBe(0)

      await vi.advanceTimersByTimeAsync(500)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
      expect(stub.markAsDelivered).not.toHaveBeenCalled()
      // No stray settle flushed the parked trigger into the dead pty.
      expect(write).toHaveBeenCalledTimes(1)
      expect(stub.rows.every((row) => row.delivered_at === null)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: graph resync replaces leaf objects, so onPtyExit flips writable only
  // on the replacement — a callback trusting its closure snapshot would still
  // read writable=true and inject Enter after the exit, without any respawn.
  it('does not fire a stale Enter through an orphaned leaf snapshot after resync and exit', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handle, write, stub } = await makeIdleLeafWithoutPtyRecord({
        probePtyLiveness: async () => null,
        hasPty: (ptyId) => ptyId === STALE_PTY_ID
      })
      stub.insert('orphaned snapshot')

      runtime.deliverPendingMessagesForHandle(handle)
      expect(write).toHaveBeenCalledTimes(1)

      // Replace the leaf object the armed callback closed over, then exit.
      publishLeafGraph(runtime, STALE_PTY_ID)
      runtime.onPtyExit(STALE_PTY_ID, 0)

      await vi.advanceTimersByTimeAsync(500)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
      expect(stub.markAsDelivered).not.toHaveBeenCalled()
      expect(stub.rows[0].delivered_at).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
