import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { buildBody, postHookEvent } from '../../server.test-fixtures'
import type * as BrainMetadata from '../../../../../../shared/agent-hook-listener/providers/antigravity/antigravity-brain-metadata'
import type * as BoundedFileReader from '../../../../../../shared/file-content/node-bounded-file-reader'
import type * as PollScheduler from '../../../../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler'
import { createPluginAgentStatusForwarder } from '../../../../../plugins/runtime/plugin-runtime-binding'
import { pluginAgentStatusListener } from '../../../../../plugins/events/plugin-agent-status-event'

const reads = vi.hoisted(() => ({
  members: 0,
  finished: 0,
  descriptors: 0,
  files: 0,
  callbacks: 0,
  released: Promise.resolve(),
  release: (): void => {}
}))

vi.mock(
  '../../../../../../shared/agent-hook-listener/transcripts/agent-transcript-poll-scheduler',
  async (importOriginal) => {
    const actual = await importOriginal<typeof PollScheduler>()
    return {
      ...actual,
      AgentTranscriptPollScheduler: class<T> extends actual.AgentTranscriptPollScheduler<T> {
        constructor(delay: number, onDue: (key: string, value: T) => void | Promise<void>) {
          super(delay, (key, value) => {
            reads.callbacks++
            return onDue(key, value)
          })
        }
      }
    }
  }
)

vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/antigravity/antigravity-brain-metadata',
  async (importOriginal) => {
    const actual = await importOriginal<typeof BrainMetadata>()
    return {
      ...actual,
      readAntigravitySwarmMembers: async (
        ...args: Parameters<typeof actual.readAntigravitySwarmMembers>
      ) => {
        reads.members++
        await reads.released
        const result = await actual.readAntigravitySwarmMembers(...args)
        reads.finished++
        return result
      },
      readAntigravityChildMetadata: (
        ...args: Parameters<typeof actual.readAntigravityChildMetadata>
      ) => {
        reads.descriptors++
        return actual.readAntigravityChildMetadata(...args)
      }
    }
  }
)

vi.mock(
  '../../../../../../shared/file-content/node-bounded-file-reader',
  async (importOriginal) => {
    const actual = await importOriginal<typeof BoundedFileReader>()
    return {
      ...actual,
      readNodeFileWithinLimit: (...args: Parameters<typeof actual.readNodeFileWithinLimit>) => {
        reads.files++
        return actual.readNodeFileWithinLimit(...args)
      }
    }
  }
)

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  reads.members = 0
  reads.finished = 0
  reads.descriptors = 0
  reads.files = 0
  reads.callbacks = 0
  reads.released = new Promise((resolve) => (reads.release = resolve))
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-poll-teardown-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

it.each([10, 100])(
  'retires reads for %s subagent panes when status hooks are disabled and reenabled mid-read',
  async (panes) => {
    const emitEvent = vi.fn()
    const terminals = Array.from({ length: panes === 10 ? 300 : 3000 }, (_, index) => ({
      handle: `terminal-${index}`,
      title: `Title ${index}`,
      tabId: `tab-${index}`,
      leafId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    }))
    const listTerminals = vi.fn(async () => ({ terminals }))
    server.subscribeEnrichedStatus(
      pluginAgentStatusListener(
        undefined,
        createPluginAgentStatusForwarder({ listTerminals }, { emitEvent, wantsEvent: () => true })
      )
    )
    for (let i = 0; i < panes; i++) {
      const leaf = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      const overrides = { paneKey: makePaneKey(`tab-${i}`, leaf), tabId: `tab-${i}` }
      const logs = join(dir, `root-${i}`, '.system_generated', 'logs')
      mkdirSync(logs, { recursive: true })
      mkdirSync(join(dir, `root-${i}`, '.system_generated', 'swarm'))
      mkdirSync(join(dir, `root-${i}`, '.system_generated', 'subagents'))
      writeFileSync(
        join(dir, `root-${i}`, '.system_generated', 'subagents', `child-${i}.json`),
        '{}'
      )
      writeFileSync(
        join(dir, `root-${i}`, '.system_generated', 'swarm', 'members.json'),
        JSON.stringify({ members: {} })
      )
      const transcriptPath = join(logs, 'transcript.jsonl')
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT' })}\n`
      )
      const root = { conversationId: `root-${i}`, lastUserInput: 'Task', transcriptPath }
      const child = { conversationId: `child-${i}`, lastUserInput: '' }
      for (const [hookEventName, payload] of [
        ['PreInvocation', root],
        ['PreInvocation', child]
      ] as const) {
        const body = buildBody(payload, { ...overrides, hookEventName })
        expect((await postHookEvent(server, body, '/hook/antigravity')).status).toBe(204)
      }
    }
    await vi.waitFor(() => expect(reads.members).toBe(panes), { timeout: 10000 })
    expect(emitEvent).toHaveBeenCalledWith(
      'agent.status.changed',
      expect.objectContaining({
        terminalId: 'terminal-0',
        title: 'Title 0',
        sessionId: 'root-0'
      })
    )
    listTerminals.mockClear()
    emitEvent.mockClear()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    server.setStatusHooksEnabled(false)
    server.setStatusHooksEnabled(true)
    reads.release()
    await vi.waitFor(() => expect(reads.finished).toBe(panes), { timeout: 10000 })
    expect(reads).toMatchObject({ members: panes, descriptors: 0, files: 0 })
    expect(server.getStatusSnapshot().some((row) => row.subagents?.length)).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(
      () =>
        expect(server.getStatusSnapshot().filter((row) => row.subagents?.length)).toHaveLength(
          panes
        ),
      { timeout: 10000 }
    )
    expect(reads.descriptors).toBe(panes)
    expect(listTerminals).not.toHaveBeenCalled()
    expect(emitEvent).not.toHaveBeenCalled()
  }
)

it.each([100, 1000])(
  'ends polling for %s completed or never-active panes and caps unresolved discovery',
  async (panes) => {
    reads.release()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const hooks: { paneKey: string; tabId: string; root: Record<string, unknown> }[] = []
    const send = async (index: number, hookEventName: string, payload: Record<string, unknown>) => {
      const pane = hooks[index]!
      expect(
        (
          await postHookEvent(
            server,
            buildBody(payload, { paneKey: pane.paneKey, tabId: pane.tabId, hookEventName }),
            '/hook/antigravity'
          )
        ).status
      ).toBe(204)
    }
    for (let index = 0; index < panes; index++) {
      const leaf = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
      const generated = join(dir, `root-${index}`, '.system_generated')
      mkdirSync(join(generated, 'logs'), { recursive: true })
      mkdirSync(join(generated, 'subagents'), { recursive: true })
      const transcriptPath = join(generated, 'logs', 'transcript.jsonl')
      writeFileSync(transcriptPath, '{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n')
      writeFileSync(
        join(generated, 'subagents', 'child.json'),
        '{"conversationId":"child","state":"SUBAGENT_STATE_ALIVE"}'
      )
      hooks.push({
        paneKey: makePaneKey(`tab-${index}`, leaf),
        tabId: `tab-${index}`,
        root: {
          conversationId: `root-${index}`,
          lastUserInput: 'Task',
          transcriptPath,
          modelName: 'root-model'
        }
      })
      await send(index, 'PreInvocation', hooks[index]!.root)
      await send(index, 'PreInvocation', {
        conversationId: 'child',
        lastUserInput: '',
        modelName: 'child-model'
      })
    }
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(
      () =>
        expect(server.getStatusSnapshot().filter((row) => row.subagents?.length)).toHaveLength(
          panes
        ),
      { timeout: 30000 }
    )
    for (let index = 0; index < panes; index++) {
      await send(index, 'Stop', { conversationId: 'child', lastUserInput: '', fullyIdle: true })
    }
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(reads.finished).toBe(reads.members), { timeout: 30000 })
    const afterChildren = reads.callbacks
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads.callbacks).toBe(afterChildren)
    for (let index = 0; index < panes; index++) {
      await send(index, 'Stop', { ...hooks[index]!.root, fullyIdle: true })
    }
    const afterIdle = reads.callbacks
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads.callbacks).toBe(afterIdle)
    const { paneKey, tabId, root } = hooks[0]
    await send(0, 'PreInvocation', { ...root, modelName: 'auto' })
    vi.setSystemTime(Date.now() + 120_001)
    server.ingestTerminalStatus({
      paneKey,
      tabId,
      worktreeId: 'wt-1',
      fromProgramStatus: true,
      payload: { state: 'done', prompt: '', agentType: 'antigravity' }
    })
    expect(server.getStatusSnapshotForPane(paneKey)[0]?.state).toBe('done')
    server.setStatusHooksEnabled(false)
    server.setStatusHooksEnabled(true)
    const completedCallbacks = reads.callbacks
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads.callbacks).toBe(completedCallbacks)
    expect(server.getStatusSnapshotForPane(paneKey)[0]?.state).toBe('done')
    await send(0, 'PreInvocation', { ...root, modelName: 'auto', initialNumSteps: 1 })
    writeFileSync(
      join(dir, 'root-0', '.system_generated', 'logs', 'transcript.jsonl'),
      '{"source":"USER_EXPLICIT","type":"USER_INPUT"}\n{"model":"new-model","step_index":2}\n'
    )
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() =>
      expect(server.getStatusSnapshotForPane(paneKey)[0]?.model).toBe('new-model')
    )
    const afterNewInvocation = reads.callbacks
    // A pane that has never run agy owns no transcript poll.
    server.ingestTerminalStatus({
      paneKey: makePaneKey('never', 'ffffffff-0000-4000-8000-000000000000'),
      payload: { state: 'done', prompt: '', agentType: 'claude' }
    })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads.callbacks).toBe(afterNewInvocation)
    for (let index = 0; index < panes; index++) {
      await send(index, 'PreInvocation', { ...hooks[index]!.root, modelName: 'auto' })
      await send(index, 'PreInvocation', { conversationId: 'unproven', lastUserInput: '' })
    }
    const beforeDiscovery = reads.callbacks
    // Advancing in small steps lets real filesystem reads settle between scheduled probes.
    for (let tick = 0; tick < 1801; tick++) {
      await vi.advanceTimersByTimeAsync(1000)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(reads.callbacks - beforeDiscovery).toBeLessThanOrEqual(12 * panes)
    const afterExpiry = reads.callbacks
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(reads.callbacks).toBe(afterExpiry)
  }
)
