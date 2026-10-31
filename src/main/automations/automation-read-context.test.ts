import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { AutomationService } from './service'
import type { HeadlessAutomationDispatchLaunch } from './headless-dispatch'
import { expect, it, vi } from 'vitest'
import { readContextFixture } from './automation-read-context.test-fixture'
import { deferred } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { structuredAttentionOrigin } from '../../shared/agent-session-attention'
import { AutomationAttentionCorrelation } from '../runtime/automation-attention-correlations'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

it.each([false, true])(
  'captures a private terminal origin while another send/prompt hides public news (read=%s)',
  async (read) => {
    const f = await readContextFixture()
    const running = await f.start()
    const release = f.rig.host.observeConversationPublications(SESSION, {
      next: (hint) => {
        const root = hint.journal?.item(
          f.rig.host.automationChatInterests.identity(running.run.id)?.turnItemId ?? ''
        )
        if (readAgentJournalTurn(root?.body)?.state === 'completed' && hint.cursor && read) {
          void f.read(hint.cursor)
        }
      },
      error: (error) => {
        throw error
      }
    })
    try {
      const observation = await f.finish(running, async () => {
        const journal = f.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
        // An accepted read of running work cannot cover its future terminal publication.
        await f.read(journal.cursor())
        const owed = f.rig.send('another send remains owed')
        await owed.result
        const sink = f.rig.providerEvents()
        sink.appendItem(
          { provider: 'codex', threadId: THREAD, turnId: 'child-prompt', ordinal: 1 },
          {
            kind: 'approval',
            title: 'Continue?',
            detail: null,
            options: [],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          },
          { agentId: 'child', turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        sink.publish()
        expect(await sink.written?.()).toEqual({ ok: true })
      })
      expect(f.edges.filter((edge) => edge.type === 'completion')).toEqual([])
      expect(observation.presentation?.attention).toBeDefined()
      await f.commit(running.run, observation)
      expect(f.changes.filter((change) => change.settledRun)).toHaveLength(read ? 0 : 1)
      expect(
        f.store.listAutomationRuns(f.definition.id).find((row) => row.id === running.run.id)?.status
      ).toBe('completed')
      expect(f.owner.get(running.run.id)).toBeUndefined()
      expect(f.rig.host.automationChatInterests.identity(running.run.id)).toBeDefined()
    } finally {
      release()
      f.dispose()
    }
  }
)

it('seals the original commit, equal to an ordinary edge and earlier than a coalesced later edge', async () => {
  const f = await readContextFixture()
  try {
    const first = await f.start()
    const observation = await f.finish(first)
    const edge = f.edges.find((edge) => edge.type === 'completion')
    if (!edge || edge.type !== 'completion') {
      throw new Error('Expected ordinary actual edge')
    }
    const delivery = observation.presentation?.attention?.take()
    expect(delivery?.origin()).toEqual(structuredAttentionOrigin(edge))
    delivery?.release()
    const next = await f.start()
    let terminal: typeof edge.completion.journalCursor
    const release = f.rig.host.observeConversationPublications(SESSION, {
      next: (hint) => {
        const root = hint.journal?.item(
          f.rig.host.automationChatInterests.identity(next.run.id)?.turnItemId ?? ''
        )
        if (hint.kind === 'commit' && readAgentJournalTurn(root?.body)?.state === 'completed') {
          terminal ??= hint.cursor
        }
      },
      error: (error) => {
        throw error
      }
    })
    const result = await f.finish(next, async () => {
      const journal = f.rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
      const rootId = f.rig.host.automationChatInterests.identity(next.run.id)?.turnItemId
      const body = rootId ? journal.item(rootId)?.body : undefined
      if (body?.kind !== 'turn') {
        throw new Error('Expected actual running root')
      }
      const options = {
        fence: f.rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
      // Idle canonical writes commit synchronously; delivery observes the coalesced later cursor.
      const final = journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: next.run.id, ordinal: 1 },
        { ...body, state: 'completed', outcome: 'success' },
        options
      )
      const intervening = journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'unrelated', ordinal: 1 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'unrelated child' }] },
        { ...options, agentId: 'child' }
      )
      await Promise.all([final, intervening])
    })
    release()
    const actual = f.edges.find(
      (event) => event.type === 'completion' && event.completion.turnId === next.run.id
    )
    const taken = result.presentation?.attention?.take()
    expect(taken?.origin()?.journalCursor).toEqual(terminal)
    if (!actual || actual.type !== 'completion' || !terminal || !actual.completion.journalCursor) {
      throw new Error('Missing coalesced controls')
    }
    expect(actual.completion.journalCursor.sequence).toBeGreaterThan(terminal.sequence)
    await f.read(terminal)
    expect(taken?.covered()).toBe(true)
    taken?.release()
  } finally {
    f.dispose()
  }
})

it.each([
  'same-reset',
  'sealed-reset',
  'writer-rebind',
  'deleted',
  'pruned',
  'disposed',
  'losing'
] as const)('ends or preserves exactly the real notification obligation at %s', async (order) => {
  const f = await readContextFixture()
  const running = await f.start()
  try {
    const observation = await f.finish(
      running,
      order === 'same-reset'
        ? async () => {
            f.rig.host.reconcileAutomationChatOwnership()
          }
        : undefined
    )
    const edge = f.edges.find((edge) => edge.type === 'completion')
    if (!edge || edge.type !== 'completion' || !edge.completion.journalCursor) {
      throw new Error('Missing source edge')
    }
    const cursor = edge.completion.journalCursor
    if (order === 'sealed-reset') {
      f.rig.host.automationChatInterests.clear()
      f.rig.host.reconcileAutomationChatOwnership()
      await f.read(cursor)
    }
    if (order === 'losing') {
      await f.writer.updateRun({ runId: running.run.id, status: 'dispatch_failed' })
      await f.commit(running.run, observation)
      expect(f.changes.filter((c) => c.settledRun)).toHaveLength(1)
      expect(f.owner.get(running.run.id)).toBeUndefined()
      return
    }
    const gate = f.authority.pause()
    const commit = f.commit(running.run, observation)
    await gate.started.promise
    if (order === 'writer-rebind') {
      await f.read(cursor)
      const old = f.rig.host
      old.automationChatInterests.clear()
      f.rig.crashRestartHostProcess()
      setStructuredAgentSessionHost(f.rig.host)
      f.rig.host.automationChatInterests.connectAttention(f.owner.get)
      f.rig.host.registerAutomationChatRun(running.run.id, SESSION, running.message)
    } else if (order === 'deleted') {
      f.store.deleteAutomation(f.definition.id)
      expect(f.owner.get(running.run.id)).toBeUndefined()
    } else if (order === 'pruned') {
      vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
      for (let i = 0; i < 101; i++) {
        const row = f.store.createAutomationRun(f.definition, 1_900_000_000_000 + i, 'manual')
        f.store.updateAutomationRun({ runId: row.id, status: 'completed' })
      }
      expect(f.owner.get(running.run.id)).toBeUndefined()
    } else if (order === 'disposed') {
      f.writer.dispose()
      expect(f.owner.get(running.run.id)).toBeUndefined()
    }
    gate.finish.resolve()
    await commit
    await f.store.flushPendingOrThrowAsync()
    expect(f.changes.filter((c) => c.settledRun)).toHaveLength(order === 'same-reset' ? 1 : 0)
    expect(f.owner.get(running.run.id)).toBeUndefined()
  } finally {
    f.dispose()
  }
})

it('fences a pending terminal read across a real same-host epoch replacement and delivers new work unread', async () => {
  const f = await readContextFixture()
  const oldAbort = new AbortController()
  const old = await f.start(undefined, oldAbort.signal)
  const entered = deferred<Awaited<ReturnType<typeof f.rig.host.journalSnapshot>>>()
  const resume = deferred<void>()
  const snapshot = f.rig.host.journalSnapshot.bind(f.rig.host)
  let held = false
  const read = vi.spyOn(f.rig.host, 'journalSnapshot').mockImplementation(async (id) => {
    const result = await snapshot(id)
    if (
      !held &&
      result.items.some((item) => readAgentJournalTurn(item.body)?.state === 'completed')
    ) {
      held = true
      entered.resolve(result)
      await resume.promise
    }
    return result
  })
  const { hints, release } = f.publications()
  const finishing = f.finish(old).then(
    (value) => value,
    (error: unknown) => error
  )
  let gate: ReturnType<typeof f.authority.pause> | undefined
  try {
    const terminal = await entered.promise
    const oldRoot = f.rig.host.automationChatInterests.identity(old.run.id)?.turnItemId
    if (!oldRoot) {
      throw new Error('Expected actual old canonical root')
    }
    expect(old.attention?.['terminal']?.cursor).toEqual(terminal.cursor)
    await f.read(terminal.cursor)
    expect(old.attention?.['read']).toBe(true)
    const source = hints.at(-1)?.source
    if (!source) {
      throw new Error('Expected actual live journal attachment')
    }
    const replacement = await f.replaceEpochRetainingMessages()
    expect(replacement.epoch).not.toBe(terminal.cursor.epoch)
    expect(hints.at(-1)).toMatchObject({ kind: 'reset', source, cursor: replacement })
    expect(hints.at(-1)?.source).toBe(source)
    expect(hints.at(-1)?.journal?.item(oldRoot)).toBeNull()
    expect(old.attention?.['terminal']).toBeUndefined()
    expect(old.attention?.['read']).toBe(false)
    expect(f.owner.get(old.run.id)).toBe(old.attention)
    const paused = read.mock.results.at(-1)
    if (!paused || paused.type !== 'return') {
      throw new Error('Expected real in-flight terminal snapshot')
    }
    resume.resolve()
    await paused.value
    expect(old.attention?.['phase']).toBe('observing')
    oldAbort.abort()
    expect(await finishing).toEqual(new Error('request_aborted'))
    expect(f.owner.get(old.run.id)).toBeUndefined()
    read.mockRestore()

    const next = await f.start()
    const result = await f.finish(next)
    const newTerminal = f.edges.find(
      (edge) => edge.type === 'completion' && edge.completion.turnId === next.run.id
    )
    if (
      !newTerminal ||
      newTerminal.type !== 'completion' ||
      !newTerminal.completion.journalCursor
    ) {
      throw new Error('Expected actual replacement-epoch terminal edge')
    }
    const origin = structuredAttentionOrigin(newTerminal)
    if (!origin) {
      throw new Error('Expected actual completion origin')
    }
    expect(origin.journalCursor.epoch).toBe(replacement.epoch)
    expect(newTerminal.completion.automationOwned).toBe(true)
    expect(f.rig.host.automationChatInterests.identity(next.run.id)?.turnItemId).not.toBe(oldRoot)
    await f.read(terminal.cursor)
    expect(next.attention?.['read']).toBe(false)
    gate = f.authority.pause()
    const commit = f.commit(next.run, result)
    await gate.started.promise
    expect(f.changes).toEqual([])
    expect(f.owner.get(next.run.id)).toBe(next.attention)
    gate.finish.resolve()
    await commit
    expect(f.changes.map(({ reason }) => reason)).toEqual(['run', 'run'])
    expect(f.changes[1].settledRun).toBeUndefined()
    expect(f.changes[0].settledRun?.presentation?.origin).toEqual(origin)
    expect(f.changes[0].settledRun?.run.id).toBe(next.run.id)
    expect(
      f.store.listAutomationRuns(f.definition.id).find((row) => row.id === next.run.id)?.status
    ).toBe('completed')
    expect(f.owner.get(next.run.id)).toBeUndefined()
    f.rig.host.reconcileAutomationChatOwnership()
    expect(f.owner.get(old.run.id)).toBeUndefined()
    expect(f.owner.get(next.run.id)).toBeUndefined()
    process.stdout.write(
      `${JSON.stringify({ phase: 'observing-epoch', oldCursor: terminal.cursor, replacement, origin, sameSource: hints.at(-1)?.source === source, liveAfter: f.owner.get(next.run.id) !== undefined })}\n`
    )
  } finally {
    resume.resolve()
    gate?.finish.resolve()
    oldAbort.abort()
    read.mockRestore()
    release()
    f.dispose()
    await finishing
  }
})

it.each(['old', 'new'] as const)(
  'preserves a sealed result across actual same-host epoch replacement using the %s-epoch read',
  async (readEpoch) => {
    const f = await readContextFixture()
    const running = await f.start()
    let gate: ReturnType<typeof f.authority.pause> | undefined
    try {
      const result = await f.finish(running)
      const oldCursor = (await f.rig.host.journalSnapshot(SESSION)).cursor
      const oldRoot = f.rig.host.automationChatInterests.identity(running.run.id)?.turnItemId
      if (!oldRoot) {
        throw new Error('Expected actual sealed canonical root')
      }
      expect(result.presentation?.attention).toBeDefined()
      expect(running.attention?.['phase']).toBe('sealed')
      const { hints, release } = f.publications()
      const source = hints[0]?.source
      if (!source) {
        throw new Error('Expected actual sealed journal attachment')
      }
      const replacement = await f.replaceEpochRetainingMessages()
      release()
      expect(replacement.epoch).not.toBe(oldCursor.epoch)
      expect(hints.at(-1)).toMatchObject({ kind: 'reset', cursor: replacement })
      expect(hints.at(-1)?.source).toBe(source)
      expect(hints.at(-1)?.journal?.item(oldRoot)).toBeNull()
      expect(running.attention?.['terminal']?.cursor).toEqual(oldCursor)
      expect(running.attention?.['phase']).toBe('sealed')
      await f.read(readEpoch === 'old' ? oldCursor : replacement)
      expect(running.attention?.['read']).toBe(readEpoch === 'old')
      gate = f.authority.pause()
      const commit = f.commit(running.run, result)
      await gate.started.promise
      expect(f.changes).toEqual([])
      expect(f.owner.get(running.run.id)).toBe(running.attention)
      gate.finish.resolve()
      await commit
      expect(f.changes.map(({ reason }) => reason)).toEqual(['run', 'run'])
      expect(f.changes[1].settledRun).toBeUndefined()
      const outcome = f.changes[0].settledRun
      expect(Boolean(outcome)).toBe(readEpoch === 'new')
      if (readEpoch === 'new') {
        expect(outcome?.presentation?.origin?.journalCursor).toEqual(oldCursor)
        expect(outcome?.presentation?.assistantMessage).toBe(
          'Checked seven repositories; all passed.'
        )
      }
      expect(
        f.store.listAutomationRuns(f.definition.id).find((row) => row.id === running.run.id)?.status
      ).toBe('completed')
      expect(f.owner.get(running.run.id)).toBeUndefined()
      f.rig.host.reconcileAutomationChatOwnership()
      await f.read(oldCursor)
      expect(f.owner.get(running.run.id)).toBeUndefined()
      process.stdout.write(
        `${JSON.stringify({ phase: 'sealed-epoch', readEpoch, oldCursor, replacement, delivered: Boolean(outcome), liveAfter: f.owner.get(running.run.id) !== undefined })}\n`
      )
    } finally {
      gate?.finish.resolve()
      f.dispose()
    }
  }
)

it('keeps publication read-addressable through reentry and removes the forwarded desktop descriptor', async () => {
  const f = await readContextFixture()
  const running = await f.start()
  try {
    const observation = await f.finish(running)
    const edge = f.edges.find((edge) => edge.type === 'completion')
    if (!edge || edge.type !== 'completion' || !edge.completion.journalCursor) {
      throw new Error('Missing completion')
    }
    f.controller.onDispatched((event) => {
      if (event.type === 'notification' && edge.completion.journalCursor) {
        f.controller.retireStructuredAttention({
          sessionId: SESSION,
          observedCursor: edge.completion.journalCursor
        })
      }
    })
    await f.commit(running.run, observation)
    expect(f.runtime.notifyAutomationsChanged).toHaveBeenCalledWith(
      expect.not.objectContaining({ settledRun: expect.anything() })
    )
    expect(f.owner.get(running.run.id)).toBeUndefined()
  } finally {
    f.dispose()
  }
})

it.each([10, 100])(
  'keeps changed-key capture independent of retained ownership and subscriber multiplicity at N=%i',
  async (n) => {
    const f = await readContextFixture()
    const observe = vi.spyOn(AutomationAttentionCorrelation.prototype, 'observe')
    const acknowledge = vi.spyOn(AutomationAttentionCorrelation.prototype, 'acknowledge')
    const releases: (() => void)[] = []
    try {
      for (let i = 0; i < n * 10; i++) {
        f.rig.host.registerAutomationChatRun(`historical-${i}`, SESSION, `old-${i}`)
      }
      for (let i = 0; i < n; i++) {
        releases.push(f.rig.host.subscribeTurnCompletions({ id: `extra-${i}`, emit: () => {} }))
      }
      const running = await f.start()
      observe.mockClear()
      const observation = await f.finish(running)
      const captures = observe.mock.calls.length
      expect(captures).toBeLessThanOrEqual(5)
      const edge = f.edges.find((edge) => edge.type === 'completion')
      if (!edge || edge.type !== 'completion' || !edge.completion.journalCursor) {
        throw new Error('Missing actual completion')
      }
      acknowledge.mockClear()
      for (let i = 0; i < n; i++) {
        await f.read(edge.completion.journalCursor)
      }
      expect(acknowledge).toHaveBeenCalledTimes(n)
      process.stdout.write(
        `${JSON.stringify({
          history: n * 10,
          subscribers: n,
          changedKeyCaptures: captures,
          reads: n,
          comparisons: acknowledge.mock.calls.length
        })}\n`
      )
      await f.commit(running.run, observation)
      expect(f.owner.get(running.run.id)).toBeUndefined()
      acknowledge.mockClear()
      await f.read(edge.completion.journalCursor)
      expect(acknowledge).not.toHaveBeenCalled()
      expect(f.changes.filter((c) => c.settledRun)).toHaveLength(0)
    } finally {
      observe.mockRestore()
      acknowledge.mockRestore()
      releases.forEach((release) => release())
      f.dispose()
    }
  }
)

it.each([
  [10, 10, 1],
  [100, 10, 1],
  [10, 100, 1],
  [10, 10, 10]
])(
  'bounds accepted reads by C_s with independent live A=%i parked P=%i C_s=%i',
  async (a, p, c) => {
    const live = await readContextFixture('live-session')
    const parked = await readContextFixture('park-session', live.controller)
    const matched = await readContextFixture('read-session', live.controller)
    const acknowledge = vi.spyOn(AutomationAttentionCorrelation.prototype, 'acknowledge')
    const catalogs = [live, parked, matched].map((f) => vi.spyOn(f.store, 'listAutomations'))
    const writes: Promise<unknown>[] = []
    const gate = parked.authority.pause()
    try {
      setStructuredAgentSessionHost(live.rig.host)
      const admissions: Awaited<ReturnType<typeof live.start>>[] = []
      for (let i = 0; i < a; i++) {
        admissions.push(await live.start())
      }
      setStructuredAgentSessionHost(parked.rig.host)
      const debt: Awaited<ReturnType<typeof parked.start>>[] = []
      for (let i = 0; i < p; i++) {
        const run = await parked.start()
        const observation = await parked.finish(run)
        debt.push(run)
        const write = parked.commit(run.run, observation)
        void write.catch(() => {})
        writes.push(write)
      }
      await gate.started.promise
      expect(debt.every((run) => parked.owner.get(run.run.id))).toBe(true)
      setStructuredAgentSessionHost(matched.rig.host)
      const results: {
        run: Awaited<ReturnType<typeof matched.start>>
        observation: Awaited<ReturnType<typeof matched.finish>>
      }[] = []
      for (let i = 0; i < c; i++) {
        const run = await matched.start()
        results.push({ run, observation: await matched.finish(run) })
      }
      const cursor = (await matched.rig.host.journalSnapshot('read-session')).cursor
      acknowledge.mockClear()
      for (let i = 0; i < 10; i++) {
        await matched.read(cursor, 'read-session')
      }
      expect(acknowledge).toHaveBeenCalledTimes(10 * c)
      process.stdout.write(
        `${JSON.stringify({
          live: a,
          parked: p,
          matching: c,
          reads: 10,
          comparisons: acknowledge.mock.calls.length,
          catalogs: catalogs.reduce((sum, spy) => sum + spy.mock.calls.length, 0)
        })}\n`
      )
      expect(admissions.every((run) => live.owner.get(run.run.id))).toBe(true)
      expect(results.every(({ run }) => matched.owner.get(run.run.id))).toBe(true)
      for (const { run, observation } of results) {
        await matched.commit(run.run, observation)
      }
      expect(matched.changes.filter((change) => change.settledRun)).toHaveLength(0)
      expect(results.every(({ run }) => matched.owner.get(run.run.id) === undefined)).toBe(true)
      gate.finish.resolve()
      await Promise.all(writes)
      await parked.store.flushPendingOrThrowAsync()
      expect(parked.changes.filter((change) => change.settledRun)).toHaveLength(p)
      expect(debt.every((run) => parked.owner.get(run.run.id) === undefined)).toBe(true)
      expect(catalogs.every((catalog) => catalog.mock.calls.length === 0)).toBe(true)
      live.dispose()
      expect(admissions.every((run) => live.owner.get(run.run.id) === undefined)).toBe(true)
    } finally {
      gate.finish.resolve()
      await Promise.allSettled(writes)
      acknowledge.mockRestore()
      catalogs.forEach((catalog) => catalog.mockRestore())
      live.dispose()
      parked.dispose()
      matched.dispose()
    }
  }
)

it.each(['abort', 'timeout', 'end', 'new-source'] as const)(
  'releases an unmatched real observation at %s without reviving its old context',
  async (ending) => {
    const f = await readContextFixture()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const running = await f.start()
    const result = running.observing.then(
      (value) => value,
      (error: unknown) => error
    )
    try {
      if (ending === 'timeout') {
        const deadline = timers.mock.calls.find((call) => Number(call[1]) > 5 * 60 * 60 * 1000)?.[0]
        if (typeof deadline !== 'function') {
          throw new Error('Expected real observer deadline')
        }
        deadline()
        expect(await result).toMatchObject({ status: 'dispatch_failed' })
      } else {
        if (ending === 'abort') {
          f.abort()
        } else if (ending === 'new-source') {
          f.rig.host.stopDelivery()
          f.rig.crashRestartHostProcess()
          setStructuredAgentSessionHost(f.rig.host)
          f.rig.host.automationChatInterests.connectAttention(f.owner.get)
        } else {
          f.rig.host.stopDelivery()
        }
        expect(await result).toBeInstanceOf(Error)
      }
      expect(f.owner.get(running.run.id)).toBeUndefined()
      await f.writer.updateRun({ runId: running.run.id, status: 'dispatch_failed' })
      expect(f.changes.filter((c) => c.settledRun)).toHaveLength(1)
      f.rig.host.reconcileAutomationChatOwnership()
      expect(f.owner.get(running.run.id)).toBeUndefined()
    } finally {
      timers.mockRestore()
      f.dispose()
    }
  }
)

it.each([false, true])(
  'retains the same real context through rejected primary and unrelated recovery (read=%s)',
  async (read) => {
    const f = await readContextFixture()
    const running = await f.start()
    const observation = await f.finish(running)
    const cursor = (await f.rig.host.journalSnapshot(SESSION)).cursor
    const fail = vi
      .spyOn(f.authority, 'writeSerializedAutomationRuns')
      .mockRejectedValue(new Error('disk full'))
    const failDomains = vi
      .spyOn(f.authority, 'writeSerializedDomains')
      .mockRejectedValue(new Error('disk full'))
    const failComplete = vi
      .spyOn(f.authority, 'writeCompleteSerializedDomains')
      .mockRejectedValue(new Error('disk full'))
    const failState = vi
      .spyOn(f.authority, 'writeSerializedState')
      .mockRejectedValue(new Error('disk full'))
    try {
      await expect(f.commit(running.run, observation)).rejects.toThrow('disk full')
      expect(f.owner.get(running.run.id)).toBeDefined()
      if (read) {
        await f.read(cursor)
      }
      f.store.updateAutomation(f.definition.id, { name: 'Later name', agentId: 'claude' })
      fail.mockRestore()
      failDomains.mockRestore()
      failComplete.mockRestore()
      failState.mockRestore()
      f.store.updateSettings({ theme: 'dark' })
      await f.store.flushPendingOrThrowAsync()
      const outcomes = f.changes.flatMap((c) => (c.settledRun ? [c.settledRun] : []))
      expect(outcomes).toHaveLength(read ? 0 : 1)
      if (!read) {
        expect(outcomes[0]).toMatchObject({
          agentId: 'codex',
          presentation: { assistantMessage: 'Checked seven repositories; all passed.' }
        })
      }
      expect(f.owner.get(running.run.id)).toBeUndefined()
      await f.writer.updateRun({ runId: running.run.id, status: 'completed', terminalPtyId: null })
      expect(f.changes.flatMap((c) => (c.settledRun ? [c.settledRun] : []))).toHaveLength(
        read ? 0 : 1
      )
    } finally {
      fail.mockRestore()
      failDomains.mockRestore()
      failComplete.mockRestore()
      failState.mockRestore()
      f.dispose()
    }
  }
)

it.each([false, true])(
  'passes a real sealed observation through accepted runner completion after stop=%s',
  async (stopped) => {
    const f = await readContextFixture()
    const launch = Promise.withResolvers<HeadlessAutomationDispatchLaunch>()
    const entered = Promise.withResolvers<Awaited<ReturnType<typeof f.start>>>()
    const service = new AutomationService(f.store, {
      attention: f.owner,
      headlessDispatcher: async ({ run }) => {
        entered.resolve(await f.start(run))
        return launch.promise
      },
      onAutomationsChanged: (payload) => f.changes.push(payload)
    })
    try {
      const definition = f.store.createAutomation({
        name: 'Real late Chat',
        prompt: 'go',
        agentId: 'codex',
        projectId: f.store.getRepos()[0].id,
        workspaceMode: 'new_per_run',
        timezone: 'UTC',
        rrule: 'FREQ=DAILY',
        dtstart: 1_800_000_000_000
      })
      const running = service.runNow(definition.id)
      const admission = await entered.promise
      const result = await f.finish(admission)
      const completion = Promise.withResolvers<typeof result>()
      launch.resolve({
        workspaceId: 'workspace-1',
        terminalSessionId: null,
        sessionKind: 'chat',
        chatSessionId: SESSION,
        completion: completion.promise
      })
      await running
      expect(f.owner.get(admission.run.id)).toBeDefined()
      if (stopped) {
        service.stop()
      }
      const gate = f.authority.pause()
      completion.resolve(result)
      await gate.started.promise
      expect(Boolean(f.owner.get(admission.run.id))).toBe(!stopped)
      gate.finish.resolve()
      await vi.waitFor(() =>
        expect(
          f.store
            .listAutomationRuns(admission.run.automationId)
            .find((r) => r.id === admission.run.id)?.status
        ).toBe('completed')
      )
      await f.store.flushPendingOrThrowAsync()
      expect(f.changes.filter((c) => c.settledRun)).toHaveLength(stopped ? 0 : 1)
      expect(f.owner.get(admission.run.id)).toBeUndefined()
      expect(f.rig.host.collaboratorsForTests().sessions['observers'].size).toBe(0)
    } finally {
      service.stop()
      f.dispose()
    }
  }
)

it.each(['providerRejected', 'cancelled', 'hostRestarted'] as const)(
  'uses canonical refusal facts for terminal capture: %s',
  async (kind) => {
    const f = await readContextFixture()
    const running = await f.start()
    try {
      await vi.waitFor(async () => {
        if (f.rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase === 'starting') {
          await f.rig.proveStart()
        }
        expect(
          f.rig.host
            .collaboratorsForTests()
            .sessions.get(SESSION)
            ?.journal.submission(running.message)?.handedOverAt
        ).toBeDefined()
      })
      await f.rig.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: running.message,
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'rejection' })
      })
      const result = await running.observing
      expect(result.status).toBe('dispatch_failed')
      expect(Boolean(result.presentation?.attention)).toBe(kind === 'providerRejected')
      await f.commit(running.run, result)
      expect(f.owner.get(running.run.id)).toBeUndefined()
      const saved = f
        .readState()
        .automationRuns.find((row: { id: string }) => row.id === running.run.id)
      expect(saved).not.toHaveProperty('presentation')
      expect(saved).not.toHaveProperty('attention')
    } finally {
      f.dispose()
    }
  }
)

it('carries the real exact-run presentation through the production watcher finalization', async () => {
  const f = await readContextFixture()
  let admission: Awaited<ReturnType<typeof f.start>> | undefined
  const service = new AutomationService(f.store, {
    attention: f.owner,
    headlessDispatcher: async ({ run }) => {
      admission = await f.start(run)
      return {
        workspaceId: 'workspace-1',
        terminalSessionId: null,
        sessionKind: 'chat',
        chatSessionId: SESSION
      }
    },
    terminalObserver: {
      resolveRunTerminal: () => 'actual-chat-observation',
      observeCompletion: async () => {
        if (!admission) {
          throw new Error('Missing real admitted Chat')
        }
        return await admission.observing
      }
    },
    onAutomationsChanged: (payload) => f.changes.push(payload)
  })
  try {
    const definition = f.store.createAutomation({
      name: 'Watched Chat',
      prompt: 'go',
      agentId: 'codex',
      projectId: f.store.getRepos()[0].id,
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1_800_000_000_000
    })
    const run = await service.runNow(definition.id)
    if (!admission) {
      throw new Error('Expected actual launch')
    }
    await f.finish(admission)
    await vi.waitFor(() => expect(f.changes.filter((c) => c.settledRun)).toHaveLength(1))
    expect(f.changes.find((c) => c.settledRun)?.settledRun).toMatchObject({
      run: { id: run.id, status: 'completed' },
      presentation: {
        assistantMessage: 'Checked seven repositories; all passed.',
        origin: { sessionId: SESSION, cause: { kind: 'completion', requestId: run.id } }
      }
    })
    expect(f.owner.get(run.id)).toBeUndefined()
    expect(f.rig.host.collaboratorsForTests().sessions['observers'].size).toBe(0)
  } finally {
    service.stop()
    f.dispose()
  }
})
