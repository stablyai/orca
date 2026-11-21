import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  descriptors: 0,
  stallTranscripts: false,
  stallDescriptor: false,
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
      } else if (path.includes('subagents') && path.endsWith('.json')) {
        reads.descriptors++
        if (reads.stallDescriptor) {
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
  reads.started = reads.settled = reads.transcripts = reads.descriptors = 0
  reads.stallTranscripts = reads.stallDescriptor = false
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

function pane(index: number, children: string[] = []) {
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
  if (children.length) {
    const descriptors = join(generated, 'subagents')
    mkdirSync(descriptors)
    for (const id of children) {
      writeFileSync(join(descriptors, `${id}.json`), JSON.stringify({ conversationId: id }))
    }
  }
  const send = async (hookEventName: string, payload: Record<string, unknown> = {}) => {
    const body = buildBody(
      { conversationId, transcriptPath, lastUserInput: 'Task', modelName: 'auto', ...payload },
      { paneKey, tabId, hookEventName }
    )
    expect((await postHookEvent(server, body, '/hook/antigravity')).status).toBe(204)
  }
  const sendChild = (id: string, hookEventName: string, extra: Record<string, unknown> = {}) =>
    send(hookEventName, {
      conversationId: id,
      lastUserInput: '',
      transcriptPath: undefined,
      modelName: 'child-model',
      ...extra
    })
  return {
    paneKey,
    leafId,
    tabId,
    send,
    sendChild,
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

it('revokes a dismissed poll before it stats the next child descriptor', async () => {
  reads.stallDescriptor = true
  const entry = pane(0, ['first', 'second'])
  await entry.send('PreInvocation', { modelName: 'root-model' })
  await entry.sendChild('first', 'PreInvocation')
  await entry.sendChild('second', 'PreInvocation')
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(reads.descriptors).toBe(1))
  server.dropStatusEntry(entry.paneKey)
  reads.release()
  await Promise.all(reads.pending)
  expect(reads).toMatchObject({ descriptors: 1, settled: 1 })
  expect(entry.row()?.subagents).toBeUndefined()
})

it('does no plugin inventory for automatic model resolution and forwards a projected transition once', async () => {
  const entry = pane(0, ['child'])
  const emitEvent = vi.fn()
  let title = 'Initial title'
  const listTerminals = vi.fn(async () => ({
    terminals: [{ handle: 'terminal-0', title, tabId: entry.tabId, leafId: entry.leafId }]
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

  await entry.sendChild('child', 'PreInvocation')
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(entry.row()?.subagents).toHaveLength(1))
  await entry.send('Stop', { fullyIdle: true })
  await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1))
  title = 'Updated title'
  listTerminals.mockClear()
  emitEvent.mockClear()
  await entry.sendChild('child', 'PreToolUse', { toolCall: { name: 'ask_question', args: {} } })
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(emitEvent).toHaveBeenCalledTimes(1))
  expect(listTerminals).toHaveBeenCalledTimes(1)
  expect(emitEvent).toHaveBeenCalledWith(
    'agent.status.changed',
    expect.objectContaining({
      state: 'waiting',
      terminalId: 'terminal-0',
      title: 'Updated title',
      sessionId: 'root-0'
    })
  )
})
