import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { AcpToolTimeline } from '../../acp/acp-tool-timeline'
import { PiRpcMessages } from '../../pi/rpc-messages'
import { PiRpcContextUsage } from '../../pi/rpc-context-usage'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION,
  GENERATION,
  NAMESPACE
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import { journalPayload } from './journal-payload-bounds'

const cleanups: (() => void)[] = []
afterEach(async () => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  await closeProviderTimelineRigs()
})

it.each(['direct', 'transition'] as const)(
  'persists complete content through %s admission and SQLite reopen',
  async (path) => {
    const rig = await openProviderTimelineRig()
    const gate = Promise.withResolvers<void>()
    cleanups.push(() => gate.resolve())
    const identity = {
      provider: 'legacy' as const,
      agent: 'grok',
      sessionId: SESSION,
      recordId: 'full'
    }
    const options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true }
    const text = `${'\u0001'.repeat(3 * 1024 * 1024)}MIDDLE${'x'.repeat(5 * 1024 * 1024)}TAIL`
    const body = {
      kind: 'tool-call' as const,
      name: 'bash',
      input: { large: 'i'.repeat(1024 * 1024) },
      state: 'completed' as const,
      output: journalPayload(text)
    }
    const cursor = rig.journal.cursor()
    const snapshot = rig.journal.snapshot()
    const blocked = rig.journal.readInOrder(() => {
      expect(
        rig.eventSink.tryAppendItem?.(
          { ...identity, recordId: 'before' },
          { kind: 'status', tone: 'info', text: 'before' },
          options
        )
      ).toEqual({ accepted: true })
      return gate.promise
    })
    expect(rig.journal.cursor()).toEqual(cursor)
    expect(rig.journal.snapshot()).toEqual(snapshot)
    const append = () =>
      path === 'direct'
        ? rig.eventSink.tryAppendItem?.(identity, body, options)
        : rig.sink.tryAppendTransition({
            lifecycle: true,
            publish: true,
            steps: [
              {
                kind: 'item',
                reservedBytes: estimateStructuredAgentSessionItemBytes(identity, body),
                options,
                resolve: () => ({ identity, body })
              }
            ]
          })
    expect(append()).toEqual({ accepted: true })
    let landed = false
    const written = rig.eventSink.written?.().then((result) => {
      landed = true
      return result
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(rig.journal.cursor()).toEqual(cursor)
    expect(rig.journal.snapshot()).toEqual(snapshot)
    expect(landed).toBe(false)
    gate.resolve()
    await blocked
    expect(await written).toEqual({ ok: true })
    const reopened = await rig.reopenJournal()
    expect(reopened.snapshot().items.map((item) => item.body)).toEqual([
      { kind: 'status', tone: 'info', text: 'before' },
      body
    ])
  }
)

it.each(['acp', 'pi'] as const)(
  'transfers %s full fields at an omitted-field close without saving whole running revisions',
  async (agent) => {
    const rig = await openProviderTimelineRig()
    const onFailed = vi.fn()
    const lane = new JsonlRpcTimelineLane({
      sink: rig.sink,
      sessionId: SESSION,
      generation: GENERATION,
      namespace: NAMESPACE,
      agent: 'grok',
      pauseReading: vi.fn(),
      resumeReading: vi.fn(),
      onInputAccepted: vi.fn(),
      onFailed
    })
    cleanups.push(() => lane.dispose())
    const acp = new AcpToolTimeline(),
      pi = new PiRpcMessages(GENERATION, new PiRpcContextUsage())
    const size = (agent === 'acp' ? 9 : 2) * 1024 * 1024
    const input = { text: 'i'.repeat(size) },
      output = 'o'.repeat(size)
    for (const id of ['one', 'two']) {
      lane.apply(
        agent === 'acp'
          ? acp.translate(
              { toolCallId: id, name: 'bash', status: 'in_progress', rawInput: input },
              {},
              {}
            )
          : pi.tool({ type: 'tool_execution_start', toolCallId: id, toolName: 'bash', args: input })
      )
      await rig.rows()
      lane.retry()
      await lane.drained()
      lane.apply(
        agent === 'acp'
          ? acp.translate({ toolCallId: id, rawOutput: output }, {}, {})
          : pi.tool({
              type: 'tool_execution_update',
              toolCallId: id,
              toolName: 'bash',
              partialResult: { content: [{ type: 'text', text: output }] }
            })
      )
      await rig.rows()
      lane.retry()
      await lane.drained()
      const update =
        agent === 'acp'
          ? acp.translate({ toolCallId: id, status: 'in_progress' }, {}, {})
          : pi.tool({ type: 'tool_execution_update', toolCallId: id, toolName: 'bash' })
      const changed = update.find((event) => event.type === 'item.update')
      const again =
        agent === 'acp'
          ? acp.translate({ toolCallId: id, status: 'in_progress' }, {}, {})
          : pi.tool({ type: 'tool_execution_update', toolCallId: id, toolName: 'bash' })
      const repeated = again.find((event) => event.type === 'item.update')
      if (
        changed?.type !== 'item.update' ||
        repeated?.type !== 'item.update' ||
        changed.body.kind !== 'tool-call' ||
        repeated.body.kind !== 'tool-call'
      ) {
        throw new Error('Expected running tool updates')
      }
      expect(repeated.body.input).toBe(changed.body.input)
      expect(repeated.body.output).toBe(changed.body.output)
    }
    expect(agent === 'acp' ? acp.retainedToolBytes : pi.retainedToolBytes).toBeGreaterThan(4 * size)
    expect(
      (await rig.rows())
        .filter((row) => row.body.kind === 'tool-call')
        .every((row) => JSON.stringify(row.body).length < 40_000)
    ).toBe(true)
    for (const id of ['one', 'two']) {
      lane.apply(
        agent === 'acp'
          ? acp.translate({ toolCallId: id, status: 'completed' }, {}, {})
          : pi.tool({ type: 'tool_execution_end', toolCallId: id, toolName: 'bash' })
      )
      await rig.rows()
      lane.retry()
      await lane.drained()
    }
    expect(agent === 'acp' ? acp.retainedToolBytes : pi.retainedToolBytes).toBe(0)
    expect(onFailed).not.toHaveBeenCalled()
    const reopened = await rig.reopenJournal()
    expect(reopened.snapshot().items.map((row) => row.body)).toEqual(
      ['one', 'two'].map((callId) =>
        expect.objectContaining({
          kind: 'tool-call',
          callId,
          input,
          state: 'completed',
          output: journalPayload(output)
        })
      )
    )
  }
)
