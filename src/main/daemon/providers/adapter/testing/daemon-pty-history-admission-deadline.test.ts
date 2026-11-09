import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HistoryReader } from '../../../history/restoration/history-reader'
import { pendingTerminalHistoryRetirement } from '../../../../pty/pending-terminal-history-retirement'
import { preserveFencedTerminalHistory } from '../../../../pty/pty-history-preserving-termination'
import type { DaemonClient } from '../../../transport/client/daemon-client'
import type { ListSessionsResult } from '../../../protocol/daemon-rpc-contract'
import type { SessionInfo } from '../../../protocol/daemon-session-info'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'
import { CheckpointSessionQueue } from '../../checkpointing/daemon-checkpoint-session-queue'
import { DaemonHistoryRetirement } from '../daemon-history-retirement'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const snapshot: TerminalSnapshot = {
  snapshotAnsi: 'before admission',
  scrollbackAnsi: '',
  rehydrateSequences: '',
  cwd: '/original',
  cols: 80,
  rows: 24,
  scrollbackLines: 0,
  modes: {
    bracketedPaste: false,
    mouseTracking: false,
    applicationCursor: false,
    alternateScreen: false
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('history writer admission deadlines', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let adapter: DaemonPtyAdapter
  let successor: DaemonPtyAdapter
  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    mkdirSync(join(harness.dir, 'history'), { mode: 0o700 })
    const options = {
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(harness.dir, 'history')
    }
    adapter = new DaemonPtyAdapter(options)
    successor = new DaemonPtyAdapter(options)
  })
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all([adapter.dispose(), successor.dispose()])
    await harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  it('releases the real reconciliation lock at expiry without canceling old output or starting late recovery', async () => {
    const result = await adapter.spawn({ sessionId: 'workspace@@aabbccdd', cols: 80, rows: 24 })
    const manager = adapter.getHistoryManager()!
    await manager.checkpoint(result.id, snapshot)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real adapter owns this client and queue; the test delays actual admitted work.
    const { client, checkpointQueue } = adapter as unknown as {
      client: DaemonClient
      checkpointQueue: CheckpointSessionQueue
    }
    const listed = await client.request<ListSessionsResult>('listSessions', undefined)
    const session = listed.sessions.find((entry) => entry.sessionId === result.id)!
    const gate = deferred()
    const entered = deferred()
    const tail = checkpointQueue.run(result.id, async (receipt) => {
      entered.resolve()
      await gate.promise
      await manager.checkpoint(
        result.id,
        { ...snapshot, snapshotAnsi: 'old output after expiry' },
        undefined,
        receipt
      )
    })
    await entered.promise
    const exited = deferred()
    const unsubscribe = adapter.onExit(() => exited.resolve())
    const request = {
      id: result.id,
      expectedIncarnationId: result.incarnationId!,
      requireNoAgentOwner: false,
      requireUnattached: false
    }
    const stopping = adapter.killFenced(preserveFencedTerminalHistory(request))
    await exited.promise
    const releaseSettlement = adapter[pendingTerminalHistoryRetirement](request)!.hold()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real successor implements these protected reconciliation and lock methods.
    const reconcile = successor as unknown as {
      reconcileLiveSessionHistory: (session: SessionInfo) => Promise<void>
      withHistorySpawnLock: <T>(id: string, operation: () => Promise<T>) => Promise<T>
    }
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const recovery = reconcile.reconcileLiveSessionHistory(session)
      const rejected = expect(recovery).rejects.toThrow(
        'terminal_history_writer_admission_unavailable'
      )
      await vi.advanceTimersByTimeAsync(15_000)
      await rejected
      expect(await reconcile.withHistorySpawnLock(result.id, async () => 'released')).toBe(
        'released'
      )
      expect(successor.getHistoryManager()!.hasWriter(result.id)).toBe(false)
      expect(manager.hasWriter(result.id)).toBe(true)
      vi.useRealTimers()
      gate.resolve()
      await tail
      releaseSettlement()
      await stopping
      expect(successor.getHistoryManager()!.hasWriter(result.id)).toBe(false)
      expect(
        await new HistoryReader(join(harness.dir, 'history')).detectColdRestore(result.id)
      ).toMatchObject({ snapshotAnsi: 'old output after expiry' })
      await reconcile.reconcileLiveSessionHistory(session)
      expect(
        await successor
          .getHistoryManager()!
          .checkpoint(result.id, { ...snapshot, snapshotAnsi: 'successful retry' })
      ).toBe('committed')
    } finally {
      vi.useRealTimers()
      gate.resolve()
      releaseSettlement()
      await Promise.allSettled([tail, stopping])
      unsubscribe()
    }
  })

  it.each(['supplied-freeze', 'retired-preparation', 'manager-release'] as const)(
    'abandons %s before mutation and recovers the actual predecessor on retry',
    async (mode) => {
      const manager = adapter.getHistoryManager()!
      const reader = new HistoryReader(join(harness.dir, 'history'))
      const next = successor.getHistoryManager()!
      const id = 'workspace@@decafbad'
      await manager.openSession(id, { cwd: '/original', cols: 80, rows: 24 })
      await manager.checkpoint(id, snapshot)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const freeze = mode === 'supplied-freeze' ? await next.freezeForRecovery(id) : undefined
      if (freeze) {
        await vi.advanceTimersByTimeAsync(10_000)
      }
      const gate = deferred()
      const entered = deferred()
      const queue = new CheckpointSessionQueue()
      const tail = queue.run(id, async () => {
        entered.resolve()
        await gate.promise
        await manager.checkpoint(id, { ...snapshot, snapshotAnsi: 'predecessor retained output' })
      })
      await entered.promise
      let retirement: DaemonHistoryRetirement | undefined
      if (mode === 'retired-preparation') {
        manager.retireIdentity((key) => queue.captureTail(key))
      } else {
        retirement = new DaemonHistoryRetirement(
          'old-incarnation',
          { pid: 1, startedAtMs: 1, launchNonce: 'test-owner' },
          manager,
          id,
          manager.captureWriter(id)!,
          queue,
          () => {}
        )
      }
      try {
        const waiting = freeze ? next.reopenSession(id, freeze) : next.freezeForRecovery(id)
        const settled = freeze
          ? expect(waiting).resolves.toBeUndefined()
          : expect(waiting).rejects.toThrow('terminal_history_writer_admission_unavailable')
        await (mode === 'manager-release'
          ? next.releaseIdentity('detach')
          : vi.advanceTimersByTimeAsync(freeze ? 5_000 : 15_000))
        await settled
        expect(next.hasWriter(id)).toBe(false)
        expect(manager.hasWriter(id)).toBe(true)
        vi.useRealTimers()
        gate.resolve()
        await tail
        if (retirement) {
          retirement.removeHistory()
          await retirement.finish(true)
        }
        expect(next.hasWriter(id)).toBe(false)
        expect(await reader.detectColdRestore(id)).toMatchObject({
          snapshotAnsi: 'predecessor retained output'
        })
        if (mode !== 'manager-release') {
          const retried = await next.freezeForRecovery(id)
          await next.reopenSession(id, retried)
          expect(await next.checkpoint(id, { ...snapshot, snapshotAnsi: 'retry output' })).toBe(
            'committed'
          )
        } else {
          await next.registerWriter(id)
          expect(next.hasWriter(id)).toBe(false)
        }
      } finally {
        vi.useRealTimers()
        gate.resolve()
        await tail
        await retirement?.finish(true)
      }
    }
  )
})
