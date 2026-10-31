import { afterEach, expect, it, vi } from 'vitest'
import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { codexItemIdentity, CodexTurnOrdinals } from './codex-structured-item-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import {
  openTestJournalHostDatabase,
  readTestJournalOutcomes
} from '../native-chat/agent-session-journal/journal-host-database-test-support'

afterEach(closeCheckpointTestJournals)

const P = 'P'.repeat(100)
const Q = 'Q'.repeat(100)
const T = 'T'.repeat(64)

async function pressureRig(primaryThreadId?: string) {
  const r = await checkpointJournalRig({
    watermarks: { maxQueuedOperations: 2, lowQueuedOperations: 0, lowQueuedBytes: 0 }
  })
  r.translator.dispose()
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const translator = createCodexJournalTranslator({
    sink: r.deferred.sink,
    bindPromptItemId: () => {},
    primaryThreadId: () => primaryThreadId ?? null,
    isCurrent: () => !session.ended && !session.orcaClose
  })
  const io = { thread: 'thread', paused: false }
  const notify = (method: string, params: unknown) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: io.thread,
      method,
      params
    })
  const connection: CodexAppServerConnection = {
    pid: undefined,
    closed: false,
    request: async () => null,
    notify: () => {},
    respond: () => {},
    respondWithError: () => {},
    close: async () => true,
    pauseReading: vi.fn(() => {
      io.paused = true
    }),
    resumeReading: vi.fn(() => {
      io.paused = false
    })
  }
  const fatal = vi.fn(async (reason: Error) => {
    session.orcaClose = { requested: false, reason }
    return false
  })
  const session: CodexSession = {
    connection,
    ended: false,
    forceCloseUnexpected: fatal,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: io.thread,
    turnOpenWaits: createCodexTurnOpenWaits(),
    prompts: new CodexPromptRegistry(),
    options: new Map(),
    reportedOptions: {},
    dispatchEchoes: createCodexDispatchEchoes(),
    backgroundTasks: new CodexBackgroundTaskTracker(io.thread),
    translator
  }
  const retries = createCodexStructuredNotificationRetry({
    sessionFor: () => session,
    translate: (_id, _session, method, params) => notify(method, params)
  })
  // Same queue low-water resume seam as acquisition; no future provider frame is needed.
  const unbind = r.deferred.sink.bindReadingControl?.({
    pauseReading: () => connection.pauseReading?.(),
    resumeReading: () => {
      connection.resumeReading?.()
      retries.retry('session', connection)
    }
  })
  const send = (method: string, params: unknown) => retries.handle('session', method, params)
  const row = (id: string, journal = r.journal, threadId = 'thread', type = 'agentMessage') =>
    journal.item(
      agentJournalItemKey(
        codexItemIdentity({
          threadId,
          turnId: null,
          item: { type, id },
          ordinals: new CodexTurnOrdinals()
        })
      )
    )
  const text = (id: string, journal = r.journal, threadId = 'thread', type = 'agentMessage') => {
    const body = row(id, journal, threadId, type)?.body
    if (type === 'plan' && body?.kind === 'status') {
      return body.text
    }
    return body?.kind === 'message' && body.blocks[0]?.type === 'text'
      ? body.blocks[0].text
      : undefined
  }
  const tick = async (ms = 60) => {
    await vi.advanceTimersByTimeAsync(ms)
    await r.deferred.drained()
  }
  const seed = async (id: string, delta = P, method = 'item/agentMessage/delta') => {
    expect(notify(method, { itemId: id, delta })).toEqual({ accepted: true })
    translator.flush()
    await r.deferred.drained()
  }
  const track = async (id: string) => {
    expect(notify('item/started', { item: { type: 'agentMessage', id, text: '' } })).toEqual({
      accepted: true
    })
    await r.deferred.drained()
  }
  const block = async (count = 2) => {
    const gate = Promise.withResolvers<void>()
    await r.journal.readInOrder(() => {
      void r.journal.readInOrder(() => gate.promise)
    })
    for (const uuid of ['block', 'block-2'].slice(0, count)) {
      expect(
        r.deferred.sink.tryAppendItem?.(
          { provider: 'claude', sessionId: 'block', uuid },
          { kind: 'status', tone: 'info', text: uuid },
          { turnScope: { kind: 'thread' } }
        )
      ).toEqual({ accepted: true })
    }
    return gate
  }
  const reopen = async () => {
    // Check liveness before cleanup can cancel timers or release reads.
    expect(fatal).not.toHaveBeenCalled()
    expect(io.paused).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    retries.clear('session', connection)
    unbind?.()
    translator.dispose()
    await r.journal.close()
    return r.reopen()
  }
  vi.advanceTimersByTime(60)
  return {
    r,
    translator,
    io,
    notify,
    send,
    row,
    text,
    tick,
    seed,
    track,
    block,
    reopen,
    fatal,
    retries,
    connection,
    unbind
  }
}

it.each(
  (['agentMessage', 'plan'] as const).flatMap((type) =>
    (['drain', 'closed', 'tracked-incoming'] as const).map((boundary) => ({ type, boundary }))
  )
)(
  'retains $type pressure tail and incoming notification until $boundary without another provider frame',
  async ({ type, boundary }) => {
    const method = type === 'plan' ? 'item/plan/delta' : 'item/agentMessage/delta'
    const h = await pressureRig()
    for (let i = 0; i < 256; i++) {
      await h.seed(`m${i}`, P, method)
    }
    const first = h.row('m0', h.r.journal, 'thread', type)
    vi.advanceTimersByTime(40)
    h.notify(method, { itemId: 'm0', delta: T })
    await h.tick()
    expect(h.text('m0', h.r.journal, 'thread', type)).toBe(P)
    vi.advanceTimersByTime(10)
    const gate = await h.block()
    const thread = boundary === 'tracked-incoming' ? 'thread-b' : 'thread'
    h.io.thread = thread
    try {
      if (boundary === 'tracked-incoming') {
        expect(h.send('item/started', { item: { type, id: 'm256', text: '' } })).toEqual({
          accepted: true
        })
      }
      expect(h.send(method, { itemId: 'm256', delta: 'incoming' })).toEqual({
        accepted: false,
        reason: 'backpressure'
      })
      expect(h.io.paused).toBe(true)
      expect(h.text('m256', h.r.journal, thread, type)).toBeUndefined()
      if (boundary === 'closed') {
        h.r.deferred.close()
      }
    } finally {
      gate.resolve()
    }
    await h.r.deferred.drained()
    await h.tick(25)
    if (boundary === 'closed') {
      expect(h.fatal).toHaveBeenCalledTimes(1)
      expect(String(h.fatal.mock.calls[0]?.[0])).toContain('closed')
      expect(h.text('m0', h.r.journal, 'thread', type)).toBe(P) // T was never admitted before definitive failure.
      expect(h.io.paused).toBe(false)
      // A prearmed plan callback may check the now-closing owner once; it cannot deliver or rearm.
      await h.tick(400)
      expect(h.text('m0', h.r.journal, 'thread', type)).toBe(P)
      expect(vi.getTimerCount()).toBe(0)
      h.retries.clear('session', h.connection)
      h.unbind?.()
      h.translator.dispose()
    } else {
      expect(h.text('m0', h.r.journal, 'thread', type)).toBe(P + T)
      await h.tick()
      expect(h.text('m256', h.r.journal, thread, type)).toBe('incoming')
      expect(h.row('m0', h.r.journal, 'thread', type)).toMatchObject({
        sequence: first?.sequence,
        observedAt: first?.observedAt,
        turnScope: first?.turnScope
      })
      expect(h.row('m256', h.r.journal, thread, type)!.sequence).toBeGreaterThan(first!.sequence)
      if (type === 'plan') {
        const original = h.row('m0', h.r.journal, 'thread', type)!
        expect(original.body).toMatchObject({
          kind: 'status',
          presentation: 'plan-document',
          text: P + T
        })
        expect(
          h.r.journal.publicRead().snapshot.items.find((item) => item.itemId === original.itemId)
        ).toEqual(original)
        const incoming = h.row('m256', h.r.journal, thread, type)!
        const changes = h.r.journal.readSince({ epoch: h.r.journal.epoch, sequence: 0 })
        expect(
          changes.ok &&
            changes.rows.filter(
              (row) => row.kind === 'outcome' && row.itemIds.includes(incoming.itemId)
            )
        ).toHaveLength(1)
        expect(
          readTestJournalOutcomes(openTestJournalHostDatabase(h.r.root).db, 'recovery')
            .filter(
              (value) =>
                value.field === 'items' &&
                value.key === JSON.stringify(incoming.itemId) &&
                !value.deleted
            )
            .map((value) => JSON.parse(value.json))
        ).toEqual([incoming])
      }
      const reopened = await h.reopen()
      expect(h.text('m0', reopened, 'thread', type)).toBe(P + T)
      expect(h.text('m256', reopened, thread, type)).toBe('incoming')
      if (type === 'plan') {
        expect(h.row('m0', reopened, 'thread', type)).toMatchObject({
          itemId: first?.itemId,
          sequence: first?.sequence,
          observedAt: first?.observedAt,
          turnScope: first?.turnScope,
          body: { kind: 'status', text: P + T, presentation: 'plan-document' }
        })
      }
    }
  }
)

it.each(['own-key', 'two-live', 'tracked-first'] as const)(
  'preserves live full owners after refused metadata creation: %s',
  async (shape) => {
    const h = await pressureRig()
    await h.seed('m0')
    const first = h.row('m0')
    if (shape === 'two-live') {
      await h.seed('m1', Q)
    }
    for (let i = shape === 'two-live' ? 2 : 1; i < 256; i++) {
      await h.track(`m${i}`)
    }
    const gate = await h.block()
    try {
      expect(
        h.send('item/started', { item: { type: 'agentMessage', id: 'm256', text: '' } })
      ).toEqual({ accepted: true })
    } finally {
      gate.resolve()
    }
    await h.r.deferred.drained()
    await h.tick(500)
    if (shape === 'tracked-first') {
      h.send('item/agentMessage/delta', { itemId: 'm5', delta: 'X' })
      await h.tick()
    }
    if (shape === 'own-key') {
      expect(h.send('item/agentMessage/delta', { itemId: 'm0', delta: '' })).toEqual({
        accepted: true
      })
      expect(vi.getTimerCount()).toBe(0)
    }
    h.send('item/agentMessage/delta', { itemId: 'm0', delta: 'U' })
    await h.tick()
    if (shape !== 'own-key') {
      h.send('item/agentMessage/delta', { itemId: shape === 'two-live' ? 'm1' : 'm0', delta: 'V' })
      await h.tick()
    }
    h.send('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'done' } })
    await h.tick(1000)
    expect(h.text('m0')).toBe(shape === 'two-live' || shape === 'own-key' ? `${P}U` : `${P}UV`)
    if (shape === 'two-live') {
      expect(h.text('m1')).toBe(`${Q}V`)
    }
    if (shape === 'tracked-first') {
      expect(h.text('m5')).toBe('X')
    }
    expect(h.text('m2')).toBe('done')
    expect(h.row('m0')).toMatchObject({
      sequence: first?.sequence,
      observedAt: first?.observedAt,
      turnScope: first?.turnScope
    })
    const reopened = await h.reopen()
    expect(h.text('m0', reopened)).toBe(
      shape === 'two-live' || shape === 'own-key' ? `${P}U` : `${P}UV`
    )
    if (shape === 'two-live') {
      expect(h.text('m1', reopened)).toBe(`${Q}V`)
    }
    if (shape === 'tracked-first') {
      expect(h.text('m5', reopened)).toBe('X')
    }
    expect(h.text('m2', reopened)).toBe('done')
  }
)

it('allocates one real buffer without trimming past it through a shielded tracked key', async () => {
  const h = await pressureRig()
  await h.seed('s0')
  await h.track('h')
  for (let i = 2; i < 256; i++) {
    await h.seed(`s${i}`)
  }
  const first = h.row('s2')
  const gate = await h.block()
  try {
    for (const id of ['t256', 't257']) {
      h.send('item/started', { item: { type: 'agentMessage', id, text: '' } })
    }
  } finally {
    gate.resolve()
  }
  await h.r.deferred.drained()
  await h.tick(500)
  for (const [itemId, delta] of [
    ['t256', 'Y'],
    ['h', 'Z'],
    ['s2', 'W']
  ]) {
    h.send('item/agentMessage/delta', { itemId, delta })
    await h.tick()
  }
  h.send('item/completed', { item: { type: 'agentMessage', id: 't257', text: 'done' } })
  await h.tick(1000)
  const expected = { s0: P, h: 'Z', t256: 'Y', s2: `${P}W`, t257: 'done' }
  for (const [id, text] of Object.entries(expected)) {
    expect(h.text(id)).toBe(text)
  }
  expect(h.row('s2')).toMatchObject({
    sequence: first?.sequence,
    observedAt: first?.observedAt,
    turnScope: first?.turnScope
  })
  const reopened = await h.reopen()
  for (const [id, text] of Object.entries(expected)) {
    expect(h.text(id, reopened)).toBe(text)
  }
})

it('late persistent command protection frees the slot without an unrelated forced save', async () => {
  const h = await pressureRig()
  await h.seed('command', 'C', 'item/commandExecution/outputDelta')
  for (let i = 1; i < 256; i++) {
    await h.seed(`m${i}`)
  }
  h.notify('item/started', {
    item: {
      type: 'commandExecution',
      id: 'command',
      source: 'unifiedExecStartup',
      command: 'echo C'
    }
  })
  await h.r.deferred.drained()
  vi.advanceTimersByTime(40)
  h.notify('item/agentMessage/delta', { itemId: 'm1', delta: T })
  await h.tick()
  const gate = await h.block()
  let incoming
  try {
    incoming = h.send('item/agentMessage/delta', { itemId: 'incoming', delta: 'I' })
  } finally {
    gate.resolve()
  }
  await h.r.deferred.drained()
  await h.tick()
  h.translator.flush()
  await h.r.deferred.drained()
  expect(incoming).toEqual({ accepted: true })
  expect(h.text('m1')).toBe(P + T)
  expect(h.text('incoming')).toBe('I')
  const reopened = await h.reopen()
  expect(h.text('m1', reopened)).toBe(P + T)
  expect(h.text('incoming', reopened)).toBe('I')
})

it('retries refused new empty metadata creation before a first meaningful delta', async () => {
  const h = await pressureRig()
  for (let i = 0; i < 256; i++) {
    await h.seed(`m${i}`)
  }
  const first = h.row('m0')
  h.notify('item/agentMessage/delta', { itemId: 'm0', delta: T })
  await h.tick()
  expect(h.text('m0')).toBe(P)
  const gate = await h.block()
  try {
    expect(h.send('item/agentMessage/delta', { itemId: 'empty', delta: '' })).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(h.text('empty')).toBeUndefined()
  } finally {
    gate.resolve()
  }
  await h.r.deferred.drained()
  await h.tick(25)
  // The empty retry has no allocation query: only creation rollback rechecks this metadata trim.
  expect(h.text('m0')).toBe(P + T)
  expect(h.text('empty')).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  h.send('item/agentMessage/delta', { itemId: 'empty', delta: 'I' })
  await h.tick()
  expect(h.text('empty')).toBe('I')
  expect(h.row('m0')).toMatchObject({
    sequence: first?.sequence,
    observedAt: first?.observedAt,
    turnScope: first?.turnScope
  })
  const reopened = await h.reopen()
  expect(h.text('m0', reopened)).toBe(P + T)
  expect(h.text('empty', reopened)).toBe('I')
})

it('retains an existing patch owner through real refused admission and later output', async () => {
  const h = await pressureRig('root')
  await h.seed('patch', P, 'item/fileChange/outputDelta')
  const first = h.row('patch', h.r.journal, 'thread', 'fileChange')
  for (let i = 1; i < 256; i++) {
    await h.track(`m${i}`)
  }
  const gate = await h.block()
  const changes = [
    { path: 'src/app.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }
  ]
  try {
    h.send('item/started', { item: { type: 'agentMessage', id: 'm256', text: '' } })
    expect(h.send('item/fileChange/patchUpdated', { itemId: 'patch', changes })).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
  } finally {
    gate.resolve()
  }
  await h.r.deferred.drained()
  await h.tick(25)
  const patch = h.row('patch', h.r.journal, 'thread', 'fileChange')
  expect(patch?.body).toMatchObject({
    kind: 'diff',
    path: 'src/app.ts',
    patch: { head: changes[0].diff }
  })
  expect(patch).toMatchObject({
    sequence: first?.sequence,
    observedAt: first?.observedAt,
    turnScope: first?.turnScope,
    agentId: 'thread',
    producerKind: 'agent'
  })
  h.send('item/fileChange/outputDelta', { itemId: 'patch', delta: 'U' })
  await h.tick()
  h.translator.flush()
  await h.r.deferred.drained()
  expect(h.row('patch', h.r.journal, 'thread', 'fileChange')?.body).toMatchObject({
    kind: 'diff',
    path: 'src/app.ts',
    patch: { head: `${P}U` }
  })
  const reopened = await h.reopen()
  expect(h.row('patch', reopened, 'thread', 'fileChange')?.body).toMatchObject({
    kind: 'diff',
    path: 'src/app.ts',
    patch: { head: `${P}U` }
  })
})

it('saves the actual nontext victim below geometric growth before allocating a tracked incoming buffer', async () => {
  const h = await pressureRig()
  await h.seed('command', P, 'item/commandExecution/outputDelta')
  for (let i = 1; i < 256; i++) {
    await h.seed(`m${i}`)
  }
  h.notify('item/commandExecution/outputDelta', { itemId: 'command', delta: 'T' })
  await h.tick()
  expect(h.row('command', h.r.journal, 'thread', 'commandExecution')?.body).toMatchObject({
    output: { head: P }
  })
  const gate = await h.block()
  h.io.thread = 'thread-b'
  try {
    h.send('item/started', { item: { type: 'agentMessage', id: 'incoming', text: '' } })
    expect(h.send('item/agentMessage/delta', { itemId: 'incoming', delta: 'I' })).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    expect(h.text('incoming', h.r.journal, 'thread-b')).toBeUndefined()
  } finally {
    gate.resolve()
  }
  await h.r.deferred.drained()
  await h.tick(25)
  await h.tick()
  expect(h.row('command', h.r.journal, 'thread', 'commandExecution')?.body).toMatchObject({
    output: { head: `${P}T` }
  })
  expect(h.text('incoming', h.r.journal, 'thread-b')).toBe('I')
  const reopened = await h.reopen()
  expect(h.row('command', reopened, 'thread', 'commandExecution')?.body).toMatchObject({
    output: { head: `${P}T` }
  })
  expect(h.text('incoming', reopened, 'thread-b')).toBe('I')
})

it('retries the complete plan after native append admission but publication refusal without spending the accepted clock', async () => {
  const h = await pressureRig()
  await h.seed('plan', 'P', 'item/plan/delta')
  const first = h.row('plan', h.r.journal, 'thread', 'plan')
  await h.tick(100)
  h.notify('item/plan/delta', { itemId: 'plan', delta: 'T' })
  await h.tick(60)
  const gate = await h.block(1)
  const append = vi.spyOn(h.r.deferred.sink, 'tryAppendItem')
  const publish = vi.spyOn(h.r.deferred.sink, 'tryPublish')
  const publications = h.r.publish.mock.calls.length
  vi.advanceTimersByTime(240)
  expect(append.mock.results.at(-1)).toMatchObject({ type: 'return', value: { accepted: true } })
  expect(publish.mock.results.at(-1)).toMatchObject({
    type: 'return',
    value: { accepted: false, reason: 'backpressure' }
  })
  expect(h.io.paused).toBe(true)
  expect(h.text('plan', h.r.journal, 'thread', 'plan')).toBe('P')
  gate.resolve()
  expect((await h.r.deferred.drained()).ok).toBe(true)
  // The admitted append may COMMIT independently; that is not a successful publication/cadence admission.
  expect(h.text('plan', h.r.journal, 'thread', 'plan')).toBe('PT')
  expect(h.r.publish).toHaveBeenCalledTimes(publications)
  await h.tick(60)
  expect(h.r.publish).toHaveBeenCalledTimes(publications + 1)
  expect(append.mock.calls.slice(-2).map(([, body]) => body)).toEqual([
    { kind: 'status', presentation: 'plan-document', text: 'PT' },
    { kind: 'status', presentation: 'plan-document', text: 'PT' }
  ])
  h.notify('item/plan/delta', { itemId: 'plan', delta: 'U' })
  await h.tick(399)
  expect(h.r.publish).toHaveBeenCalledTimes(publications + 1)
  await h.tick(1)
  expect(h.text('plan', h.r.journal, 'thread', 'plan')).toBe('PTU')
  expect(h.row('plan', h.r.journal, 'thread', 'plan')).toMatchObject({
    sequence: first?.sequence,
    observedAt: first?.observedAt,
    turnScope: first?.turnScope
  })
  const reopened = await h.reopen()
  expect(h.text('plan', reopened, 'thread', 'plan')).toBe('PTU')
})
