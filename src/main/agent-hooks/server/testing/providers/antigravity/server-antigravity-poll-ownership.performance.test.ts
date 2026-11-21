import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  transcripts: 0,
  stallTranscripts: false,
  released: Promise.resolve(),
  release: (): void => {}
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = args[0].toString()
      if (path.endsWith('transcript.jsonl')) {
        reads.transcripts++
        if (reads.stallTranscripts) {
          await reads.released
        }
      }
      return actual.stat(...args)
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
          onDue: (key: string, value: T, wanted: () => boolean) => void | Promise<void>
        ) {
          super(delay, (key, value, wanted) => {
            reads.started++
            const poll = (async () => onDue(key, value, wanted))().finally(() => {
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
      server.dropStatusEntry(entry.paneKey)
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
  expect(reads.settled).toBe(1)

  reads.release()
  await oldPoll
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
  await entry.send('PreInvocation', { initialNumSteps: 1 })
  await entry.send('Stop', { fullyIdle: false })
  await vi.advanceTimersByTimeAsync(1000)
  expect(reads.transcripts).toBe(1)
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
  reads.release()
  await Promise.all(reads.pending)
  expect(entry.row()?.model).toBeUndefined()
  expect(entry.row()?.state).toBe('working')
  await vi.advanceTimersByTimeAsync(5000)
  expect(reads.transcripts).toBe(1)
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
