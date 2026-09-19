/**
 * The redrive edge is coalesced, and coalescing is not allowed to change what gets delivered.
 *
 * Every journal batch is a redrive candidate, because a settled turn is tombstoned rather than
 * rewritten. Once mail is parked on a session, each candidate re-resolves the dispatch, queries
 * unread mail and reads the host's gate facts — so a turn that streams tool calls paid the full
 * gate per batch, only to re-park because the turn was still running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { structuredWorkerIdentities } from '../../structured-worker-identity'
import { createStructuredWorkerSession } from './orchestration-structured-worker-session'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId }
  })
}))

type JournalEmit = (event: { type: string }) => void

/** Captures the redrive subscription so the test can drive journal batches by hand. */
function installHost(): { emit: (type: string) => void; unsubscribed: () => boolean } {
  let emitter: JournalEmit | null = null
  let disposed = false
  setStructuredAgentSessionHost({
    hasSession: () => true,
    hold: async () => {},
    release: () => {},
    subscribe: (subscription: { emit: JournalEmit }) => {
      emitter = subscription.emit
      return () => {
        disposed = true
      }
    },
    deps: {
      store: {
        getRecord: () => ({
          provider: 'claude',
          location: { executionHostId: 'local', wslDistro: null },
          lease: {
            runtimeKind: 'native',
            claimStatus: 'live',
            deathEvidence: null,
            runtimeFence: 1
          }
        })
      }
    }
  } as never)
  return {
    emit: (type: string) => emitter?.({ type }),
    unsubscribed: () => disposed
  }
}

describe('the structured redrive edge', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    vi.useFakeTimers()
    structuredWorkerIdentities.clear()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    vi.useRealTimers()
    db.close()
    setStructuredAgentSessionHost(null)
    structuredWorkerIdentities.clear()
    vi.restoreAllMocks()
  })

  async function startWorker(onJournalActivity: (sessionId: string) => void) {
    return createStructuredWorkerSession({
      runtime,
      worktreeId: 'repo::wt',
      agent: 'claude',
      dispatchId: 'd_redrive',
      onJournalActivity
    })
  }

  it('collapses a burst of mid-turn batches into one gate evaluation', async () => {
    const host = installHost()
    const onJournalActivity = vi.fn()
    await startWorker(onJournalActivity)

    for (let batch = 0; batch < 25; batch += 1) {
      host.emit('batch')
      vi.advanceTimersByTime(10)
    }

    // Still inside the quiet window: nothing has fired for 25 batches.
    expect(onJournalActivity).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(onJournalActivity).toHaveBeenCalledTimes(1)
  })

  it('delivers the settle edge once the journal goes quiet', async () => {
    const host = installHost()
    const onJournalActivity = vi.fn()
    const { identity } = await startWorker(onJournalActivity)

    host.emit('batch')
    vi.advanceTimersByTime(300)

    expect(onJournalActivity).toHaveBeenCalledTimes(1)
    expect(onJournalActivity).toHaveBeenCalledWith(identity.sessionId)
  })

  it('still re-evaluates a turn that never goes quiet', async () => {
    const host = installHost()
    const onJournalActivity = vi.fn()
    await startWorker(onJournalActivity)

    // Sustained churn inside the quiet window would starve a plain trailing edge forever.
    for (let batch = 0; batch < 60; batch += 1) {
      host.emit('batch')
      vi.advanceTimersByTime(100)
    }

    expect(onJournalActivity.mock.calls.length).toBeGreaterThan(0)
    // ...but nowhere near one per batch.
    expect(onJournalActivity.mock.calls.length).toBeLessThan(10)
  })

  it('treats a re-attach reset as the same coalesced edge', async () => {
    const host = installHost()
    const onJournalActivity = vi.fn()
    await startWorker(onJournalActivity)

    host.emit('reset')
    host.emit('batch')
    vi.advanceTimersByTime(300)

    expect(onJournalActivity).toHaveBeenCalledTimes(1)
  })

  it('drops a pending redrive when the worker settles, rather than nudging a released session', async () => {
    const host = installHost()
    const onJournalActivity = vi.fn()
    await startWorker(onJournalActivity)

    host.emit('batch')
    const { releaseStructuredWorkerSession } =
      await import('./orchestration-structured-worker-session')
    releaseStructuredWorkerSession('d_redrive', runtime)
    vi.advanceTimersByTime(5_000)

    expect(onJournalActivity).not.toHaveBeenCalled()
    expect(host.unsubscribed()).toBe(true)
  })

  it('ignores journal events that are not a batch or a reset', async () => {
    const host = installHost()
    const onJournalActivity = vi.fn()
    await startWorker(onJournalActivity)

    host.emit('snapshot')
    vi.advanceTimersByTime(5_000)

    expect(onJournalActivity).not.toHaveBeenCalled()
  })
})
