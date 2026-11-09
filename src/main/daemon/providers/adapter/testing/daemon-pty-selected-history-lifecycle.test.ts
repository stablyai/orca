import { HistoryManager } from '../../../history/storage/history-manager'
import { HistoryReader } from '../../../history/restoration/history-reader'
import { pendingTerminalHistoryRetirement } from '../../../../pty/pending-terminal-history-retirement'
import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'
import { DaemonClient } from '../../../transport/client/daemon-client'
import { acquireOrcadInstanceLock } from '../../../../orcad/orcad-instance-lock'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { DaemonPtyRouter } from '../../routing/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../../routing/degraded-daemon-pty-provider'
import { LocalPtyProvider } from '../../../../providers/local-pty/local-pty-provider'
import {
  acquireProspectivePtySpawn,
  bindProspectivePtySpawn
} from '../../../../pty/prospective-pty-spawn'
import { preserveFencedTerminalHistory } from '../../../../pty/pty-history-preserving-termination'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'
import type { CheckpointSessionQueue } from '../../checkpointing/daemon-checkpoint-session-queue'

vi.mock('../../../launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: async () => [PROTOCOL_VERSION]
}))

const snapshot: TerminalSnapshot = {
  snapshotAnsi: 'before refused stop',
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
describe('selected history physical ownership', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let adapter: DaemonPtyAdapter
  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    mkdirSync(join(harness.dir, 'history'), { mode: 0o700 })
    adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(harness.dir, 'history')
    })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await adapter.dispose()
    await harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  it.each([3, 30])(
    'only the current adapter answers census after %i real adapter retirements',
    async (count) => {
      await adapter.spawn({ sessionId: 'workspace@@c0decafe', cols: 80, rows: 24 })
      const root = adapter.getHistoryManager()!.identityRoot!
      const lock = acquireOrcadInstanceLock(harness.dir)
      await root.bindProfile(harness.dir, harness.dir, () => [])
      const requests = vi.spyOn(DaemonClient.prototype, 'request')
      const created: DaemonPtyAdapter[] = []
      try {
        for (let index = 0; index < count; index++) {
          const next = new DaemonPtyAdapter({
            socketPath: harness.socketPath,
            tokenPath: harness.tokenPath,
            historyPath: join(harness.dir, 'history')
          })
          created.push(next)
          await next.spawn({ sessionId: 'workspace@@c0decafe', cols: 80, rows: 24 })
          await adapter.retire()
          adapter = next
          requests.mockClear()
          const lease = await root.beginMigration(['9', 'workspace@@badc0ffe'], () => true)
          try {
            expect(lease).not.toBeNull()
            // One still-routed adapter is the only owner of an inventory obligation after drain.
            expect(
              requests.mock.calls.filter(
                ([type, payload]) =>
                  type === 'listSessions' &&
                  payload &&
                  typeof payload === 'object' &&
                  'includeReservations' in payload
              )
            ).toHaveLength(1)
          } finally {
            lease?.release()
          }
        }
      } finally {
        requests.mockRestore()
        await Promise.all(created.map((value) => value.retire()))
        lock.release()
      }
    }
  )

  it.each(['clean', 'detach'] as const)(
    'drains a caller-abandoned checkpoint before %s history release',
    async (disposition) => {
      const result = await adapter.spawn({ sessionId: 'workspace@@c0decafe', cols: 80, rows: 24 })
      const manager = adapter.getHistoryManager()!
      await manager.checkpoint(result.id, snapshot)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real adapter owns this queue; the test delays admitted durable work.
      const { checkpointQueue } = adapter as unknown as { checkpointQueue: CheckpointSessionQueue }
      let release!: () => void
      const gate = new Promise<void>((done) => {
        release = done
      })
      let started!: () => void
      const admitted = new Promise<void>((done) => {
        started = done
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const caller = checkpointQueue.runWithDeadline(
        result.id,
        async (receipt) => {
          started()
          await gate
          return manager.checkpoint(
            result.id,
            { ...snapshot, snapshotAnsi: 'late durable output' },
            undefined,
            receipt
          )
        },
        5,
        'unavailable'
      )
      await admitted
      await vi.advanceTimersByTimeAsync(5)
      await expect(caller).resolves.toBe('unavailable')
      const completion = adapter.retire(disposition)
      const metadata = join(
        harness.dir,
        'history',
        getHistorySessionDirName(result.id),
        'meta.json'
      )
      try {
        expect(JSON.parse(readFileSync(metadata, 'utf8')).endedAt).toBeNull()
      } finally {
        release()
      }
      await completion
      vi.useRealTimers()
      expect(
        readFileSync(
          join(harness.dir, 'history', getHistorySessionDirName(result.id), 'checkpoint.json'),
          'utf8'
        )
      ).toContain('late durable output')
      const endedAt = JSON.parse(readFileSync(metadata, 'utf8')).endedAt
      if (disposition === 'clean') {
        expect(endedAt).toEqual(expect.any(String))
      } else {
        expect(endedAt).toBeNull()
      }
      await expect(adapter.listSessions()).rejects.toThrow()
    }
  )

  it.each(['late', 'pre-admitted'] as const)(
    'preserves successor history with a %s real buffer overlay',
    async (mode) => {
      const result = await adapter.spawn({ sessionId: 'workspace@@accedeed', cols: 80, rows: 24 })
      const manager = adapter.getHistoryManager()!
      await manager.openSession('9', { cwd: '/source', cols: 80, rows: 24 })
      await manager.checkpoint('9', snapshot)
      await manager.checkpoint(result.id, snapshot)
      const sourcePath = join(harness.dir, 'history/9/checkpoint.json')
      const source = readFileSync(sourcePath)
      const gate = () => {
        let resolve!: () => void
        const promise = new Promise<void>((done) => {
          resolve = done
        })
        return { promise, resolve }
      }
      const reply = gate()
      const requested = gate()
      const lockEntered = gate()
      const releaseLock = gate()
      const rebuilding = gate()
      const releaseRebuild = gate()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These protected adapter fields drive the real delayed RPC and history lock.
      const internals = adapter as unknown as {
        client: DaemonClient
        historyReader: HistoryReader
        withHistorySpawnLock: <T>(id: string, operation: () => Promise<T>) => Promise<T>
      }
      const live = { ...snapshot, snapshotAnsi: 'live snapshot before stop', outputSequence: 7 }
      const request = internals.client.request.bind(internals.client)
      const requests = vi
        .spyOn(internals.client, 'request')
        .mockImplementation(async (type, payload) => {
          if (type === 'getSnapshot') {
            requested.resolve()
            await reply.promise
            return { snapshot: live }
          }
          if (type === 'takePendingOutput') {
            return { seq: 2, records: [], drainedRecords: [], snapshot: live }
          }
          return request(type, payload)
        })
      const readHistory = internals.historyReader.detectColdRestore.bind(internals.historyReader)
      const history = vi
        .spyOn(internals.historyReader, 'detectColdRestore')
        .mockImplementation(async (...args) => {
          const old = await readHistory(...args)
          rebuilding.resolve()
          await releaseRebuild.promise
          return old
        })
      const locked = internals.withHistorySpawnLock(result.id, async () => {
        lockEntered.resolve()
        await releaseLock.promise
      })
      await lockEntered.promise
      const reading = adapter.getBufferSnapshot(result.id)
      await requested.promise
      if (mode === 'pre-admitted') {
        reply.resolve()
        await rebuilding.promise
      }
      const stopRequest = {
        id: result.id,
        expectedIncarnationId: result.incarnationId!,
        requireNoAgentOwner: false,
        requireUnattached: false
      }
      const stopping = adapter.killFenced(preserveFencedTerminalHistory(stopRequest))
      const retirement = adapter[pendingTerminalHistoryRetirement](stopRequest)!
      const releaseSettlement = retirement.hold()
      retirement.removeHistory()
      const successor = new HistoryManager(join(harness.dir, 'history'))
      try {
        reply.resolve()
        // The old implementation reaches the real inherited-history rebuild before manager mutation.
        await Promise.race([reading, rebuilding.promise])
        const registered = successor.registerWriter(result.id)
        if (mode === 'pre-admitted') {
          expect(successor.hasWriter(result.id)).toBe(false)
          releaseRebuild.resolve()
          await reading
        }
        await registered
        expect(
          await successor.checkpoint(result.id, {
            ...snapshot,
            snapshotAnsi: 'new successor screen'
          })
        ).toBe('committed')
        await successor.releaseIdentity('detach')
        releaseRebuild.resolve()
        const screen = await reading
        expect(screen?.seq).toBe(7)
        expect(screen?.data).toContain(
          mode === 'late' ? 'live snapshot before stop' : 'before refused stop'
        )
        releaseLock.resolve()
        releaseSettlement()
        expect((await stopping).outcome).toBe('ended')
        expect(
          await new HistoryReader(join(harness.dir, 'history')).detectColdRestore(result.id)
        ).toMatchObject({ snapshotAnsi: 'new successor screen' })
        expect(readFileSync(sourcePath)).toEqual(source)
      } finally {
        reply.resolve()
        releaseRebuild.resolve()
        releaseLock.resolve()
        releaseSettlement()
        await Promise.allSettled([reading, stopping, locked])
        requests.mockRestore()
        history.mockRestore()
        await successor.releaseIdentity('detach')
      }
    }
  )

  it('honors ordinary destructive close racing the selected keep-history stop', async () => {
    const result = await adapter.spawn({ sessionId: 'workspace@@decafbad', cols: 80, rows: 24 })
    const manager = adapter.getHistoryManager()!
    await manager.checkpoint(result.id, snapshot)
    const request = {
      id: result.id,
      expectedIncarnationId: result.incarnationId!,
      requireNoAgentOwner: false,
      requireUnattached: false
    }
    const preserve = adapter.killFenced(preserveFencedTerminalHistory({ ...request }))
    const remove = adapter.killFenced(request)
    expect((await preserve).outcome).toBe('ended')
    expect((await remove).outcome).toBe('already_exited')
    expect(manager.hasHistory(result.id)).toBe(false)
  })

  it.each(
    (['router', 'recovered-degraded'] as const).flatMap((kind) =>
      (
        [
          'exact',
          'other-incarnation',
          'bare-source',
          'successor-writer',
          'successor-released',
          'recovery-abandoned',
          'after-settlement'
        ] as const
      ).map((mode) => ({
        kind,
        mode
      }))
    )
  )('settles $mode history after $kind removes the live route', async ({ kind, mode }) => {
    const provider =
      kind === 'router'
        ? new DaemonPtyRouter({ current: adapter, legacy: [] })
        : new DegradedDaemonPtyProvider({
            current: adapter,
            legacy: [],
            fallback: new LocalPtyProvider(),
            probeCurrentDaemonSpawn: async () => true
          })
    if (provider instanceof DegradedDaemonPtyProvider) {
      await provider.recoverFreshSpawnRouting()
    }
    const result = await provider.spawn({ sessionId: 'workspace@@aabbccdd', cols: 80, rows: 24 })
    const manager = adapter.getHistoryManager()!
    await manager.openSession('9', { cwd: '/source', cols: 80, rows: 24 })
    await manager.checkpoint('9', snapshot)
    const sourcePath = join(harness.dir, 'history', '9', 'checkpoint.json')
    const sourceHistory = readFileSync(sourcePath)
    await manager.checkpoint(result.id, snapshot)
    const request = {
      id: result.id,
      expectedIncarnationId: result.incarnationId!,
      requireNoAgentOwner: false,
      requireUnattached: false
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real adapter owns this queue; the test delays admitted durable work.
    const { checkpointQueue } = adapter as unknown as { checkpointQueue: CheckpointSessionQueue }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const tail = checkpointQueue.run(result.id, async (receipt) => {
      entered()
      await gate
      await manager.checkpoint(
        result.id,
        { ...snapshot, snapshotAnsi: 'last admitted output' },
        undefined,
        receipt
      )
    })
    await started
    let exited!: () => void
    const exit = new Promise<void>((resolve) => {
      exited = resolve
    })
    const unsubscribe = provider.onExit((event) => {
      if (event.id === result.id) {
        exited()
      }
    })
    const preserve = provider.killFenced(preserveFencedTerminalHistory({ ...request }))
    let remove: ReturnType<typeof provider.killFenced> | undefined
    let successor: HistoryManager | undefined
    let releaseSettlement: (() => void) | undefined
    try {
      await exit
      expect(provider.supportsFencedTermination(result.id)).toBe(false)
      if (mode === 'after-settlement') {
        release()
        await preserve
        await tail
      }
      remove = provider.killFenced(
        mode === 'bare-source'
          ? { ...request, id: '9' }
          : mode === 'other-incarnation'
            ? { ...request, expectedIncarnationId: '22222222-2222-4222-8222-222222222222' }
            : request
      )
      if (mode === 'successor-writer' || mode === 'successor-released') {
        releaseSettlement = adapter[pendingTerminalHistoryRetirement](request)!.hold()
        successor = new HistoryManager(join(harness.dir, 'history'))
        const registered = successor.registerWriter(result.id)
        expect(successor.hasWriter(result.id)).toBe(false)
        release()
        await registered
        if (mode === 'successor-released') {
          expect(
            await successor.checkpoint(result.id, { ...snapshot, snapshotAnsi: 'successor output' })
          ).toBe('committed')
          await successor.releaseIdentity('detach')
        }
        releaseSettlement()
      }
      if (mode === 'recovery-abandoned') {
        releaseSettlement = adapter[pendingTerminalHistoryRetirement](request)!.hold()
        successor = new HistoryManager(join(harness.dir, 'history'))
        const recovering = successor.freezeForRecovery(result.id)
        release()
        const freeze = await recovering
        successor.abandonRecoveryFreeze(freeze)
        await successor.releaseIdentity('detach')
        releaseSettlement()
      }
      release()
      expect((await preserve).outcome).toBe('ended')
      expect((await remove).outcome).toBe('already_exited')
      await tail
      expect(manager.hasHistory(result.id)).toBe(mode !== 'exact')
      expect(manager.hasHistory('9')).toBe(true)
      expect(readFileSync(sourcePath)).toEqual(sourceHistory)
      if (mode === 'successor-released') {
        expect(
          await new HistoryReader(join(harness.dir, 'history')).detectColdRestore(result.id)
        ).toMatchObject({ snapshotAnsi: 'successor output' })
      } else if (mode === 'successor-writer' && successor) {
        expect(
          await successor.checkpoint(result.id, { ...snapshot, snapshotAnsi: 'successor output' })
        ).toBe('committed')
      }
    } finally {
      release()
      releaseSettlement?.()
      await Promise.allSettled([preserve, remove, tail])
      unsubscribe()
      await successor?.releaseIdentity('detach')
      if (provider instanceof DaemonPtyRouter) {
        provider.disposeRouterOnly()
      } else {
        provider.disposeProviderOnly()
      }
    }
  })

  it.each(['router', 'recovered-degraded'] as const)(
    'admits a fresh scoped target through the real %s without granting unknown kill authority',
    async (kind) => {
      const provider =
        kind === 'router'
          ? new DaemonPtyRouter({ current: adapter, legacy: [] })
          : new DegradedDaemonPtyProvider({
              current: adapter,
              legacy: [],
              fallback: new LocalPtyProvider(),
              probeCurrentDaemonSpawn: async () => true
            })
      if (provider instanceof DegradedDaemonPtyProvider) {
        expect(await provider.recoverFreshSpawnRouting()).toBe(true)
      }
      const opts = { sessionId: 'workspace@@f00dcafe', cols: 80, rows: 24, cwd: '/original' }
      expect(provider.supportsFencedTermination(opts.sessionId)).toBe(false)
      const admission = await acquireProspectivePtySpawn(provider, opts)
      expect(admission).not.toBeNull()
      try {
        bindProspectivePtySpawn(opts, provider, admission!)
        const result = await provider.spawn(opts)
        expect(result.id).toBe('workspace@@f00dcafe')
        expect(provider.supportsFencedTermination(result.id)).toBe(true)
      } finally {
        admission?.release()
      }
      const next = { sessionId: 'workspace@@badc0ffe', cols: 80, rows: 24 }
      const cancelled = await acquireProspectivePtySpawn(provider, next)
      bindProspectivePtySpawn(next, provider, cancelled!)
      cancelled!.release()
      await expect(provider.spawn(next)).rejects.toThrow('Terminal spawn target changed')
      expect(adapter.hasPty('workspace@@badc0ffe')).toBe(false)
      if (provider instanceof DaemonPtyRouter) {
        provider.disposeRouterOnly()
      } else {
        provider.disposeProviderOnly()
      }
    }
  )

  it('can stop a same-endpoint successor after the old stop reply was unknown and its exit was missed', async () => {
    const first = await adapter.spawn({ sessionId: 'workspace@@facedbad', cols: 80, rows: 24 })
    const manager = adapter.getHistoryManager()!
    await manager.checkpoint(first.id, snapshot)
    const request = {
      id: first.id,
      expectedIncarnationId: first.incarnationId!,
      requireNoAgentOwner: false,
      requireUnattached: false
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real adapter owns this client; only its RPC reply is fault-injected.
    const client = (adapter as unknown as { client: DaemonClient }).client
    const unknown = vi
      .spyOn(client, 'request')
      .mockResolvedValueOnce({ outcome: 'refused', reason: 'unverifiable' })
    expect(await adapter.killFenced(preserveFencedTerminalHistory({ ...request }))).toEqual({
      outcome: 'refused',
      reason: 'unverifiable'
    })
    unknown.mockRestore()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real adapter has finishExit; the test drops one actual exit notification.
    const internals = adapter as unknown as { finishExit: (id: string, event: unknown) => void }
    const missed = vi.spyOn(internals, 'finishExit').mockImplementation(() => {})
    try {
      expect((await harness.adapter.killFenced(request)).outcome).toBe('ended')
      await vi.waitFor(() => expect(missed).toHaveBeenCalled())
    } finally {
      missed.mockRestore()
    }
    const successor = await adapter.spawn({ sessionId: first.id, cols: 80, rows: 24 })
    expect(successor.incarnationId).not.toBe(first.incarnationId)
    expect(
      await manager.checkpoint(first.id, { ...snapshot, snapshotAnsi: 'successor final screen' })
    ).toBe('committed')
    expect(
      (
        await adapter.killFenced(
          preserveFencedTerminalHistory({
            ...request,
            expectedIncarnationId: successor.incarnationId!
          })
        )
      ).outcome
    ).toBe('ended')
    expect(
      readFileSync(
        join(harness.dir, 'history', getHistorySessionDirName(first.id), 'checkpoint.json'),
        'utf8'
      )
    ).toContain('successor final screen')
  })

  it('keeps the same writer usable after an attached-owner stop is refused, and retires without reconnecting', async () => {
    const result = await adapter.spawn({ sessionId: 'workspace@@deafcafe', cols: 80, rows: 24 })
    const manager = adapter.getHistoryManager()!
    await manager.checkpoint(result.id, snapshot)
    const outcome = await adapter.killFenced(
      preserveFencedTerminalHistory({
        id: result.id,
        expectedIncarnationId: result.incarnationId!,
        requireNoAgentOwner: false,
        requireUnattached: true
      })
    )
    expect(outcome).toEqual({ outcome: 'refused', reason: 'attached' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real adapter owns this client; the test supplies a snapshot RPC reply.
    const { client } = adapter as unknown as { client: DaemonClient }
    const original = client.request.bind(client)
    const requests = vi.spyOn(client, 'request').mockImplementation(async (type, payload) => {
      const current = { ...snapshot, snapshotAnsi: 'after refused stop', outputSequence: 9 }
      if (type === 'getSnapshot') {
        return { snapshot: current }
      }
      if (type === 'takePendingOutput') {
        return { seq: 1, records: [], snapshot: current }
      }
      return original(type, payload)
    })
    try {
      expect((await adapter.getBufferSnapshot(result.id))?.data).toContain('after refused stop')
      expect(
        await new HistoryReader(join(harness.dir, 'history')).detectColdRestore(result.id)
      ).toMatchObject({ snapshotAnsi: 'after refused stop' })
    } finally {
      requests.mockRestore()
    }
    await adapter.retire()
    const meta = JSON.parse(
      readFileSync(
        join(harness.dir, 'history', getHistorySessionDirName(result.id), 'meta.json'),
        'utf8'
      )
    )
    expect(meta.endedAt).toBeNull()
    await expect(adapter.listSessions()).rejects.toThrow()
    expect(
      readFileSync(
        join(harness.dir, 'history', getHistorySessionDirName(result.id), 'checkpoint.json'),
        'utf8'
      )
    ).toContain('after refused stop')
  })
})
