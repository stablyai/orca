import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProgramStatusProjector } from '../../../../../../shared/program-status/agent-status-projector'
import { AgentHookServer } from '../../../agent-hook-server'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type * as PollScheduler from '../../../../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'
import { createPluginAgentStatusForwarder } from '../../../../../plugins/runtime/plugin-runtime-binding'
import { pluginAgentStatusListener } from '../../../../../plugins/events/plugin-agent-status-event'
import { buildBody, postHookEvent } from '../../server.test-fixtures'

const reads = vi.hoisted(() => ({
  started: 0,
  settled: 0,
  pending: new Set<Promise<void>>(),
  openTranscripts: new Set<Promise<void>>(),
  transcripts: 0,
  ranges: [] as { at: number; bytes: number }[],
  stallTranscripts: false,
  released: Promise.resolve(),
  release: (): void => {}
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = args[0].toString()
      if (!path.endsWith('transcript.jsonl')) {
        return actual.open(...args)
      }
      reads.transcripts++
      let closed!: () => void
      const transcript = new Promise<void>((resolve) => (closed = resolve))
      reads.openTranscripts.add(transcript)
      const retire = (): void => {
        reads.openTranscripts.delete(transcript)
        closed()
      }
      try {
        if (reads.stallTranscripts) {
          await reads.released
        }
        const handle = await actual.open(...args)
        const read = handle.read.bind(handle)
        return {
          stat: handle.stat.bind(handle),
          close: () => handle.close().finally(retire),
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const result = await read(buffer, offset, length, position)
            reads.ranges.push({ at: position, bytes: result.bytesRead })
            return result
          }
        }
      } catch (error) {
        retire()
        throw error
      }
    }
  }
})

vi.mock(
  '../../../../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler',
  async (importOriginal) => {
    const actual = await importOriginal<typeof PollScheduler>()
    return {
      ...actual,
      AgentTranscriptPollScheduler: class<T> extends actual.AgentTranscriptPollScheduler<T> {
        constructor(
          delay: number,
          onDue: (key: string, value: T, signal: AbortSignal) => void | Promise<void>
        ) {
          super(delay, (key, value, signal) => {
            reads.started++
            const poll = (async () => onDue(key, value, signal))().finally(() => {
              reads.settled++
              reads.pending.delete(poll)
            })
            reads.pending.add(poll)
            return poll
          })
        }
      }
    }
  }
)

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  reads.started = reads.settled = reads.transcripts = 0
  reads.stallTranscripts = false
  reads.ranges.length = 0
  reads.released = new Promise((resolve) => (reads.release = resolve))
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-poll-ownership-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
})

afterEach(async () => {
  server.stop()
  reads.release()
  await Promise.allSettled(reads.pending)
  await Promise.all(reads.openTranscripts)
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function pane(index: number) {
  const leafId = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
  const tabId = `tab-${index}`
  const paneKey = makePaneKey(tabId, leafId)
  const conversationId = `root-${index}`
  const generated = join(dir, conversationId, '.system_generated')
  const transcriptPath = join(generated, 'logs', 'transcript.jsonl')
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(
    transcriptPath,
    '{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n{"model":"resolved-model","step_index":2}\n'
  )
  const send = async (hookEventName: string, payload: Record<string, unknown> = {}) => {
    const body = buildBody(
      { conversationId, transcriptPath, lastUserInput: 'Task', modelName: 'auto', ...payload },
      { paneKey, tabId, hookEventName }
    )
    expect((await postHookEvent(server, body, '/hook/antigravity')).status).toBe(204)
  }
  return {
    paneKey,
    leafId,
    tabId,
    send,
    transcriptPath,
    row: () => server.getStatusSnapshotForPane(paneKey)[0]
  }
}

it.each([100, 1000])(
  'drops %s queued rows behind three stalled reads without filesystem admission',
  async (count) => {
    reads.stallTranscripts = true
    for (let index = 0; index < 3; index++) {
      await pane(index).send('PreInvocation', { initialNumSteps: 1 })
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toMatchObject({ started: 3, transcripts: 3, settled: 0 })

    const queued = Array.from({ length: count }, (_, index) => pane(index + 3))
    for (const entry of queued) {
      await entry.send('PreInvocation', { conversationId: undefined })
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toMatchObject({ started: 3, transcripts: 3, settled: 0 })
    for (const entry of queued) {
      await entry.send('PreInvocation', { initialNumSteps: 1 })
    }
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toMatchObject({ started: count + 3, transcripts: 3, settled: 0 })
    for (const entry of queued) {
      await entry.send('Stop', { fullyIdle: true })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(reads).toMatchObject({ transcripts: 3, settled: count })

    const successor = queued[0]!
    await successor.send('PreInvocation', { lastUserInput: 'Next task', initialNumSteps: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads).toMatchObject({ started: count + 4, transcripts: 3, settled: count })
    reads.stallTranscripts = false
    reads.release()
    await Promise.all(reads.pending)
    expect(reads).toMatchObject({ transcripts: 4, settled: count + 4 })
    expect(successor.row()?.model).toBe('resolved-model')
  }
)

it('retries after the read deadline without losing the last model or blocking a terminal hook', async () => {
  reads.stallTranscripts = true
  const entries = [pane(0), pane(1), pane(2), pane(3)]
  const queued = entries[3]!
  await queued.send('PreInvocation', { modelName: 'previous-model', lastUserInput: 'Earlier task' })
  for (const entry of entries) {
    await entry.send('PreInvocation', { initialNumSteps: 1 })
  }
  await vi.advanceTimersByTimeAsync(1000)
  expect(reads).toMatchObject({ started: 4, transcripts: 3, settled: 0 })
  await vi.advanceTimersByTimeAsync(19_999)
  expect(reads.settled).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(reads).toMatchObject({ started: 4, transcripts: 3, settled: 4 })
  expect(queued.row()).toMatchObject({ state: 'working', model: 'previous-model' })
  await vi.advanceTimersByTimeAsync(1999)
  expect(reads.started).toBe(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(reads).toMatchObject({ started: 8, transcripts: 3, settled: 8 })
  await queued.send('Stop', { fullyIdle: true })
  expect(queued.row()).toMatchObject({ state: 'done', model: 'previous-model' })
})

it.each([10, 100])(
  'reads each forward MiB and one tail from an unchanged %s MiB backlog',
  async (pages) => {
    const entry = pane(0)
    const mib = 1024 * 1024
    truncateSync(entry.transcriptPath, pages * mib - 128)
    appendFileSync(entry.transcriptPath, '\n{"model":"old-model","step_index":2}\n')
    const fileSize =
      pages * mib - 128 + Buffer.byteLength('\n{"model":"old-model","step_index":2}\n')
    await entry.send('PreInvocation', { initialNumSteps: 5 })

    for (let page = 0; page < pages; page++) {
      await vi.advanceTimersByTimeAsync(1000)
      await Promise.all(reads.pending)
    }
    expect(reads.ranges.map(({ at }) => at)).toEqual([
      0,
      fileSize - mib,
      ...Array.from({ length: pages - 1 }, (_, page) => (page + 1) * mib)
    ])
    expect(reads.ranges.reduce((sum, range) => sum + range.bytes, 0)).toBe(fileSize + mib)
    expect(entry.row()?.model).toBeUndefined()
  }
)

it('refreshes a backlog tail after append and invalidates it on truncation', async () => {
  const entry = pane(0)
  const mib = 1024 * 1024
  truncateSync(entry.transcriptPath, 8 * mib)
  appendFileSync(entry.transcriptPath, '\n{"model":"old-model","step_index":2}\n')
  await entry.send('PreInvocation', { initialNumSteps: 5 })
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all(reads.pending)
  const firstTail = reads.ranges[1]!
  expect(firstTail).toMatchObject({ bytes: mib })
  expect(entry.row()?.model).toBeUndefined()

  appendFileSync(entry.transcriptPath, '{"model":"still-old","step_index":4}\n')
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all(reads.pending)
  expect(reads.ranges.slice(2)).toEqual([
    { at: mib, bytes: mib },
    { at: firstTail.at + Buffer.byteLength('{"model":"still-old","step_index":4}\n'), bytes: mib }
  ])
  expect(entry.row()?.model).toBeUndefined()

  writeFileSync(entry.transcriptPath, '{"model":"current","step_index":5}\n')
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all(reads.pending)
  expect(reads.ranges.at(-1)).toEqual({ at: 0, bytes: 35 })
  expect(entry.row()?.model).toBe('current')
})

it('resets the forward offset and tail when the same path is replaced with equal-sized content', async () => {
  const entry = pane(0)
  const mib = 1024 * 1024
  truncateSync(entry.transcriptPath, 8 * mib)
  appendFileSync(entry.transcriptPath, '\n{"model":"old","step_index":2}\n')
  await entry.send('PreInvocation', { initialNumSteps: 5 })
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all(reads.pending)
  expect(entry.row()?.model).toBeUndefined()

  const replacement = join(dir, 'replacement.jsonl')
  writeFileSync(replacement, '')
  truncateSync(replacement, 8 * mib)
  appendFileSync(replacement, '\n{"model":"new","step_index":5}\n')
  renameSync(replacement, entry.transcriptPath)
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all(reads.pending)
  expect(reads.ranges.slice(2)).toEqual(reads.ranges.slice(0, 2))
  expect(entry.row()?.model).toBe('new')
})

it.each(['same hook', 'newer hook', 'newer turn', 'replacement owner'] as const)(
  'allows the original terminal Done only for the same hook (%s)',
  async (sequence) => {
    const entry = pane(0)
    await entry.send('PreInvocation', { initialNumSteps: 1 })
    const original = entry.row()!
    const delayBeforeDone = sequence === 'same hook' ? 500 : 0
    if (delayBeforeDone) {
      await vi.advanceTimersByTimeAsync(delayBeforeDone)
    }
    const { payloads, facet } = createProgramStatusProjector().process(
      '\x1b]7501;app=antigravity:state=done\x1b\\'
    )
    server.ingestProgramStatusFacet({ paneKey: entry.paneKey, facet: facet ?? null })
    server.ingestTerminalStatus({
      paneKey: entry.paneKey,
      tabId: entry.tabId,
      worktreeId: 'wt-1',
      connectionId: null,
      fromProgramStatus: true,
      payload: payloads[0]!.payload
    })
    expect(entry.row()?.state).toBe('working')
    if (sequence === 'newer hook') {
      await entry.send('PreToolUse', { toolCall: { name: 'read_file' } })
    } else if (sequence === 'newer turn') {
      await entry.send('PreInvocation', { initialNumSteps: 1, lastUserInput: 'New task' })
    } else if (sequence === 'replacement owner') {
      await entry.send('PreInvocation', { conversationId: 'replacement', initialNumSteps: 1 })
    }
    const beforeModel = entry.row()!
    await vi.advanceTimersByTimeAsync(1000 - delayBeforeDone)
    await Promise.all(reads.pending)
    expect(entry.row()).toMatchObject({
      state: 'working',
      model: 'resolved-model',
      receivedAt: beforeModel.receivedAt,
      evidenceObservedAt: beforeModel.evidenceObservedAt,
      observation: beforeModel.observation
    })
    if (sequence === 'same hook') {
      expect(entry.row()?.receivedAt).toBe(original.receivedAt)
    }
    await vi.advanceTimersByTimeAsync(119_000)
    expect(entry.row()?.state).toBe('working')
    await vi.advanceTimersByTimeAsync(1)
    expect(entry.row()).toMatchObject({
      state: sequence === 'same hook' ? 'done' : 'working',
      model: 'resolved-model'
    })
  }
)

it('ignores an in-flight model when the root explicitly selects another model', async () => {
  const entry = pane(0)
  reads.stallTranscripts = true
  await entry.send('PreInvocation', { initialNumSteps: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(reads.transcripts).toBe(1)
  await entry.send('PreToolUse', { modelName: 'explicit-model', toolCall: { name: 'read_file' } })
  reads.release()
  await Promise.all(reads.pending)
  expect(entry.row()?.model).toBe('explicit-model')
  await vi.advanceTimersByTimeAsync(5000)
  expect(reads.transcripts).toBe(1)
})

it('lets a replacement root poll while the old transcript read is stalled', async () => {
  const entry = pane(0)
  reads.stallTranscripts = true
  await entry.send('PreInvocation', { initialNumSteps: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  const [oldPoll] = reads.pending
  expect(reads.transcripts).toBe(1)

  const transcriptPath = join(dir, 'replacement', 'transcript.jsonl')
  mkdirSync(dirname(transcriptPath), { recursive: true })
  writeFileSync(
    transcriptPath,
    '{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n{"model":"new-root-model","step_index":2}\n'
  )
  reads.stallTranscripts = false
  await entry.send('PreInvocation', {
    conversationId: 'replacement',
    transcriptPath,
    initialNumSteps: 1
  })
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all([...reads.pending].filter((poll) => poll !== oldPoll))
  expect(entry.row()?.model).toBe('new-root-model')
  expect(reads.settled).toBe(2)

  reads.release()
  await oldPoll
  await Promise.all(reads.openTranscripts)
  expect(entry.row()?.providerSession?.id).toBe('replacement')
  expect(entry.row()?.model).toBe('new-root-model')
})

it('recovers the root model after an oversized unfinished record and file truncation', async () => {
  const entry = pane(0)
  writeFileSync(
    entry.transcriptPath,
    `{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n${'x'.repeat(2 * 1024 * 1024)}`
  )
  await entry.send('PreInvocation', { initialNumSteps: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  await Promise.all(reads.pending)
  expect(entry.row()?.model).toBeUndefined()
  writeFileSync(entry.transcriptPath, '')
  await vi.advanceTimersByTimeAsync(2000)
  await Promise.all(reads.pending)
  appendFileSync(entry.transcriptPath, '{"model":"fresh-model","step_index":2}\n')
  await vi.advanceTimersByTimeAsync(5000)
  await Promise.all(reads.pending)
  expect(entry.row()?.model).toBe('fresh-model')
})

it('stops model reads at hook silence while a busy Stop leaves the row working', async () => {
  const entry = pane(0)
  reads.stallTranscripts = true
  await pane(1).send('PreInvocation', { initialNumSteps: 1 })
  await pane(2).send('PreInvocation', { initialNumSteps: 1 })
  await entry.send('PreInvocation', { initialNumSteps: 1 })
  await entry.send('Stop', { fullyIdle: false })
  await vi.advanceTimersByTimeAsync(1000)
  expect(reads.transcripts).toBe(3)
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
  const attempts = reads.started
  reads.release()
  await Promise.all(reads.openTranscripts)
  expect(entry.row()?.model).toBeUndefined()
  expect(entry.row()?.state).toBe('working')
  await vi.advanceTimersByTimeAsync(5000)
  expect(reads.started).toBe(attempts)
  expect(reads.transcripts).toBe(3)
})

it.each([
  { withSteps: true, previousModel: 'first-model' },
  { withSteps: false, previousModel: 'first-model' },
  { withSteps: false, previousModel: undefined }
])(
  'uses the current turn model with step indices=$withSteps and previous model=$previousModel',
  async ({ withSteps, previousModel }) => {
    const entry = pane(0)
    vi.setSystemTime(Date.parse('2030-01-01T12:00:00.600Z'))
    if (previousModel) {
      await entry.send('PreInvocation', { modelName: previousModel })
      await entry.send('Stop', { fullyIdle: true })
    }
    const model = (name: string, at: string | undefined, step: number) =>
      appendFileSync(
        entry.transcriptPath,
        `${JSON.stringify({
          type: 'PLANNER_RESPONSE',
          model: name,
          created_at: at,
          ...(withSteps ? { step_index: step } : {})
        })}\n`
      )
    model('old-transcript-model', '2030-01-01T12:00:00Z', 5)
    await entry.send('PreInvocation', { initialNumSteps: withSteps ? 6 : undefined })
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all(reads.pending)
    expect(entry.row()?.model).toBe(previousModel)
    if (!withSteps) {
      model('undated-transcript-model', undefined, 6)
      await vi.advanceTimersByTimeAsync(5000)
      await Promise.all(reads.pending)
      expect(entry.row()?.model).toBe(previousModel)
    }
    model('new-transcript-model', withSteps ? '2030-01-01T12:00:00Z' : '2030-01-01T12:00:01Z', 7)
    await vi.advanceTimersByTimeAsync(5000)
    await Promise.all(reads.pending)
    expect(entry.row()?.model).toBe('new-transcript-model')
  }
)

it('does no plugin inventory for automatic model resolution and forwards a projected transition once', async () => {
  const entry = pane(0)
  const emitEvent = vi.fn()
  const listTerminals = vi.fn(async () => ({
    terminals: [
      { handle: 'terminal-0', title: 'Terminal title', tabId: entry.tabId, leafId: entry.leafId }
    ]
  }))
  server.subscribeEnrichedStatus(
    pluginAgentStatusListener(
      undefined,
      createPluginAgentStatusForwarder({ listTerminals }, { emitEvent, wantsEvent: () => true })
    )
  )
  await entry.send('PreInvocation', { initialNumSteps: 1 })
  await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1))
  listTerminals.mockClear()
  emitEvent.mockClear()
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(entry.row()?.model).toBe('resolved-model'))
  expect(listTerminals).not.toHaveBeenCalled()
  expect(emitEvent).not.toHaveBeenCalled()

  await entry.send('PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1))
  expect(listTerminals).toHaveBeenCalledTimes(1)
  expect(emitEvent).toHaveBeenCalledWith(
    'agent.status.changed',
    expect.objectContaining({
      state: 'waiting',
      terminalId: 'terminal-0',
      title: 'Terminal title',
      sessionId: 'root-0'
    })
  )
})
