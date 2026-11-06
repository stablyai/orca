import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  GENERATION,
  NAMESPACE,
  openProviderTimelineRig,
  providerTurnItemId,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { AcpStructuredLane } from './acp-structured-lane'
import { AcpItemOwnership } from './acp-item-ownership'
import { retainedCollectionEntries } from './acp-ownership-test-support'
import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

describe('ACP ownership publication handoff', () => {
  it.each([200, 2000])(
    'bounds publication debt and recovers old ownership across %i turns',
    async (turns) => {
      const rig = await openProviderTimelineRig()
      let pendingWork = 0
      let capturedWork = 0
      let checkpoints = 0
      const publication = AcpItemOwnership.prototype.publication
      vi.spyOn(AcpItemOwnership.prototype, 'publication').mockImplementation(function (
        this: AcpItemOwnership
      ) {
        const before = retainedCollectionEntries(this)
        const publish = publication.call(this)
        if (!publish) {
          return undefined
        }
        // A checkpoint transfers collection entries from the registry into its callback.
        const captured = before - retainedCollectionEntries(this)
        pendingWork += captured
        capturedWork += captured
        checkpoints += 1
        return () => {
          publish()
          pendingWork -= captured
        }
      })
      let release: (() => void) | undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const append = rig.journal.appendSteps.bind(rig.journal)
      vi.spyOn(rig.journal, 'appendSteps').mockImplementation(async (steps) => {
        await held
        return append(steps)
      })
      let refusing: 'backpressure' | 'failed' | undefined = 'backpressure'
      const onFailed = vi.fn()
      const lane = new AcpStructuredLane({
        sink: {
          ...rig.sink,
          tryAppendTransition: (transition) =>
            refusing
              ? { accepted: false, reason: refusing }
              : rig.sink.tryAppendTransition(transition)
        },
        sessionId: SESSION,
        agent: 'grok',
        agentName: 'Grok',
        generation: GENERATION,
        providerSessionId: NAMESPACE,
        dialect: GROK_ACP_DIALECT,
        logger: recordingStructuredAgentSessionLogger().logger,
        onInputAccepted: () => {},
        onFailed
      })
      const translator = lane.translator
      const notify = (update: unknown, promptId?: string) =>
        lane.apply(
          translator.notification(
            'session/update',
            {
              sessionId: NAMESPACE,
              ...(promptId ? { _meta: { promptId } } : {}),
              update
            },
            1000
          )
        )
      const complete = (index: number) => {
        lane.apply(translator.openPrompt(`send-${index}`, 1000).events)
        notify(
          {
            sessionUpdate: 'tool_call',
            toolCallId: `tool-${index}`,
            title: 'Read',
            status: 'completed'
          },
          `prompt:send-${index}`
        )
        notify(
          {
            sessionUpdate: 'agent_thought_chunk',
            messageId: `message-${index}`,
            content: { type: 'text', text: 'Private thought' }
          },
          `prompt:send-${index}`
        )
        lane.apply(translator.promptResult(`send-${index}`, { stopReason: 'end_turn' }, 1100))
      }
      for (let index = 0; index < 3; index += 1) {
        complete(index)
      }
      // The first phase stays in the lane backlog; the second is admitted but cannot publish.
      expect(pendingWork).toBe(15)
      // Per turn: 3 pending + 5 captured + 2 cached-start entries; latest closed has 2 keys.
      expect(retainedCollectionEntries(translator) + pendingWork).toBeLessThanOrEqual(10 * 3 + 2)
      refusing = undefined
      lane.retry()
      expect(pendingWork).toBe(15)
      expect(rig.journal.snapshot().items).toHaveLength(0)
      lane.apply(translator.openPrompt('current', 1200).events)
      notify(
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Current thought' }
        },
        'prompt:current'
      )
      const request = (id: string) => {
        const events = translator.request(
          'session/request_permission',
          {
            sessionId: NAMESPACE,
            toolCall: { toolCallId: 'tool-0', title: 'Run?' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
          },
          id
        ).events
        lane.apply(events)
        return events
      }
      request('unpublished')
      const task = (id: string) =>
        lane.apply(
          translator.notification(
            'x.ai/task_backgrounded',
            {
              sessionId: NAMESPACE,
              update: {
                sessionUpdate: 'task_backgrounded',
                task_id: id,
                tool_call_id: 'tool-0',
                command: 'sleep 15',
                description: 'Wait for command',
                output_file: '/workspace/output.log'
              }
            },
            1300
          )
        )
      task('unpublished-task')
      const late = {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'message-0',
        content: { type: 'text', text: 'Must not enter current reply' }
      }
      expect(
        translator.notification('session/update', { sessionId: NAMESPACE, update: late }, 1400)
      ).toEqual([])
      lane.apply([])
      release?.()
      const before = await rig.rows()
      expect(pendingWork).toBe(0)
      const tool = before.find(
        (row) => row.body.kind === 'tool-call' && row.body.callId === 'tool-0'
      )
      expect(tool?.turnScope).toMatchObject({ kind: 'turn' })
      const approval = before.find((row) => row.body.kind === 'approval')
      expect(approval).toMatchObject({
        turnScope: tool?.turnScope,
        body: { resolution: { state: 'pending' } }
      })
      const taskRow = before.find(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some((block) => block.type === 'background-task')
      )
      expect(taskRow?.turnScope).toEqual(tool?.turnScope)
      lane.apply(translator.promptResult('current', { stopReason: 'end_turn' }, 1400))
      for (let index = 3; index < turns; index += 1) {
        complete(index)
        await rig.sink.written?.()
        expect(pendingWork).toBe(0)
        // Existing start caches: 256; last ownership keys: 2; one running task: 1.
        expect(retainedCollectionEntries(translator)).toBeLessThanOrEqual(259)
      }
      // Two birth tokens, two settled tokens and one end token per turn; current has only an end.
      expect(capturedWork).toBe(5 * turns + 1)
      expect(checkpoints).toBe(3 * turns + 1)
      lane.apply(translator.openPrompt('latest', 1450).events)
      const readBody = vi.spyOn(rig.journal, 'itemBody')
      const chunk = {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'latest-message',
        content: { type: 'text', text: 'x' }
      }
      const measuredChunk = () => {
        const before = readBody.mock.calls.length
        const events = translator.notification(
          'session/update',
          { sessionId: NAMESPACE, _meta: { promptId: 'prompt:latest' }, update: chunk },
          1450
        )
        const reads = readBody.mock.calls.length - before
        lane.apply(events)
        return { reads, events }
      }
      const first = measuredChunk()
      expect(first.events).toContainEqual(expect.objectContaining({ type: 'turn.open' }))
      expect(first.reads).toBeLessThanOrEqual(1)
      lane.flush()
      await rig.sink.written?.()
      const beforeChunks = checkpoints
      let turnReads = 0
      for (let index = 0; index < turns; index += 1) {
        turnReads += measuredChunk().reads
      }
      // Each notification needs one fresh durable settlement observation, reused by its helpers.
      expect(turnReads).toBeLessThanOrEqual(turns)
      expect(checkpoints).toBe(beforeChunks)
      lane.flush()
      // After publication, the old owner is recovered from journal rows beyond the closed generation.
      expect(request('published')[0]).toMatchObject({ join: { scope: tool?.turnScope } })
      task('published-task')
      expect(
        translator.notification('session/update', { sessionId: NAMESPACE, update: late }, 1500)
      ).toEqual([])
      lane.apply([])
      const after = await rig.rows()
      expect(
        after.filter((row) => row.body.kind === 'approval').map((row) => row.turnScope)
      ).toEqual([tool?.turnScope, tool?.turnScope])
      expect(
        after.filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
      ).toMatchObject([{ body: { blocks: [{ type: 'text', text: 'x'.repeat(turns + 1) }] } }])
      expect((await rig.turns()).at(-1)?.state).toBe('running')
      expect(pendingWork).toBe(0)
      // 256 cached starts, 2 closed keys, 3 live membership entries and 2 running tasks.
      expect(retainedCollectionEntries(translator)).toBeLessThanOrEqual(263)
      const latest = await rig.turn('prompt:latest')
      const identity = parseAgentJournalItemKey(providerTurnItemId('prompt:latest'))
      if (!latest || !identity) {
        throw new Error('Expected the published live turn')
      }
      await rig.journal.appendItem(
        identity,
        agentJournalTurnBody({ ...latest, state: 'interrupted', completedAt: 1501 }),
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      expect(measuredChunk()).toEqual({ reads: 1, events: [] })
      lane.flush()
      expect(
        (await rig.rows()).filter(
          (row) => row.body.kind === 'message' && row.body.role === 'assistant'
        )
      ).toMatchObject([{ body: { blocks: [{ type: 'text', text: 'x'.repeat(turns + 1) }] } }])
      expect(onFailed).not.toHaveBeenCalled()
      let releaseTeardown: (() => void) | undefined
      const teardown = new Promise<void>((resolve) => {
        releaseTeardown = resolve
      })
      vi.mocked(rig.journal.appendSteps).mockImplementation(async (steps) => {
        await teardown
        return append(steps)
      })
      lane.apply(translator.promptResult('latest', { stopReason: 'end_turn' }, 1550))
      expect(
        translator.notification('session/update', { sessionId: NAMESPACE, update: chunk }, 1551)
      ).toEqual([])
      expect(pendingWork).toBeGreaterThan(0)
      refusing = 'failed'
      request('permanently-refused')
      expect(onFailed).toHaveBeenCalledWith('failed')
      lane.dispose()
      releaseTeardown?.()
      await rig.sink.written?.()
      expect(pendingWork).toBe(0)
      expect(
        translator.notification('session/update', { sessionId: NAMESPACE, update: late }, 1600)
      ).toEqual([])
    },
    60_000
  )
})
