import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import * as historyBatch from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import { journalLifecycleMutationItemId } from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { AcpAgentError } from './acp-errors'
import { z } from 'zod'
import { continuedOutsideNotice } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import {
  closeProviderTimelineRigs,
  AGENT,
  SESSION,
  NAMESPACE
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { readAcpFixture, type AcpFixtureFrame } from './acp-timeline-fixture.test-support'
import { PromptRequestSchema } from './generated/acp-protocol.generated'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { settleObservedExitForTest } from '../native-chat/agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import { catchUpAcpHistory } from './acp-history-catch-up'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import {
  setup,
  dividers,
  chatSend,
  replayUpdate,
  userReplay,
  answerReplay
} from './acp-history-catch-up.test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

async function recording(name: string): Promise<AcpFixtureFrame[]> {
  return JSON.parse(
    JSON.stringify(await readAcpFixture(name)).replaceAll('"session-1"', JSON.stringify(NAMESPACE))
  )
}

describe('ACP recovered history boundaries', () => {
  it('recovers a rejected answer write after durable reopens and completes the next send', async () => {
    const { fixture } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const frames = await recording('opencode-v2-reopen')
    const prompt = frames[0]!
    const promptText = PromptRequestSchema.parse(prompt.message.params)
      .prompt.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    const accept = async (journal: AgentSessionJournal, id: string, text: string) => {
      await journal.appendSubmission({
        clientMessageId: id,
        payloadFingerprint: id,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: id,
        fence: 1,
        state: 'accepted',
        providerIdentity: null
      })
    }
    await accept(fixture.rig.journal, 'A:4', promptText)
    await fixture.feed([prompt])
    const failure = new Error('controlled answer resolver failure')
    const append = fixture.rig.journal.appendSteps
    const reject = vi.spyOn(fixture.rig.journal, 'appendSteps').mockImplementation((steps) =>
      append(
        steps.map((step) =>
          step.kind !== 'item'
            ? step
            : {
                ...step,
                resolve: () => {
                  const item = step.resolve()
                  if (item?.body.kind === 'message' && item.body.role === 'assistant') {
                    throw failure
                  }
                  return item
                }
              }
        )
      )
    )
    const answer = frames.find((frame) =>
      JSON.stringify(frame.message.params ?? {}).includes('"agent_message_chunk"')
    )!
    await fixture.feed([answer])
    expect(await fixture.rig.eventSink.written?.()).toEqual({ ok: false, error: failure })
    reject.mockRestore()
    fixture.rig.assembler.dispose()
    await settleObservedExitForTest({
      journal: fixture.rig.journal,
      sessionId: SESSION,
      fence: 1,
      settlementId: 'save-failed',
      pendingSubmissionReason: 'journal sink failure',
      exitFailure: agentSessionFailureFact('hostFault'),
      verdict: { state: 'interrupted', completedAt: 1200 },
      exit: { ownerFence: 1, observedAt: 1200 }
    })
    const saved = await fixture.rig.rows()
    const dispatch = structuredClone(fixture.rig.journal.submissions())
    const failed = saved.find(
      (row) => row.body.kind === 'status' && row.body.failure?.kind === 'hostFault'
    )!
    expect(failed).toBeDefined()
    expect(saved.some((row) => row.body.kind === 'message' && row.body.role === 'assistant')).toBe(
      false
    )
    const loading = frames.filter((frame) => frame.process === 'B')
    const replay = loading
      .slice(
        1,
        loading.findIndex((frame) => frame.direction === 'in' && frame.message.id !== undefined)
      )
      .map((frame) => ({
        method: frame.message.method!,
        params: frame.message.params
      }))
    let recovered = saved
    for (const opening of [1, 2]) {
      const journal = await fixture.rig.reopenJournal()
      const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
      deferred.bind({ journal, fence: 1, publish: () => {} })
      const sink = providerTimelineSink(deferred.sink)!
      const assembler = createProviderTimelineAssembler({
        sink,
        sessionId: SESSION,
        agent: AGENT,
        namespace: NAMESPACE,
        generation: `reopened-${opening}`,
        schedule: () => () => {}
      })
      const lane = new AcpTimelineTranslator({
        sessionId: NAMESPACE,
        dialect: OPENCODE_ACP_DIALECT
      })
      try {
        await catchUpAcpHistory({
          frames: replay,
          identity: 'user-message-id',
          sink: deferred.sink,
          sessionId: SESSION,
          agent: AGENT,
          providerSessionId: NAMESPACE,
          dialect: OPENCODE_ACP_DIALECT,
          assertCurrent: () => {}
        })
        const rows = journal.snapshot().items
        expect(rows.slice(0, saved.length)).toEqual(saved)
        expect(journal.submissions()).toEqual(dispatch)
        expect(
          rows.some(
            (row) =>
              row.body.kind === 'message' &&
              row.body.role === 'assistant' &&
              row.body.blocks.some((block) => block.type === 'text' && block.text === 'TOOL-OK')
          )
        ).toBe(true)
        expect(dividers(rows)).toHaveLength(0)
        if (opening === 1) {
          recovered = structuredClone(rows)
        } else {
          expect(rows).toEqual(recovered)
          await accept(journal, 'next', 'next')
          for (const event of [
            ...lane.openPrompt('next', 2000).events,
            ...lane.notification(
              'session/update',
              answerReplay('NEXT', 'next-answer').params,
              2100
            ),
            ...lane.promptResult('next', { stopReason: 'end_turn' }, 2200)
          ]) {
            expect(assembler.apply(event).admission.accepted).toBe(true)
          }
          assembler.flush()
          expect(await deferred.drained()).toEqual({ ok: true })
          expect((await fixture.rig.turns()).at(-1)?.state).toBe('completed')
          expect(
            journal
              .snapshot()
              .items.some(
                (row) =>
                  row.body.kind === 'message' &&
                  row.body.role === 'assistant' &&
                  row.body.blocks.some((block) => block.type === 'text' && block.text === 'NEXT')
              )
          ).toBe(true)
        }
      } finally {
        lane.dispose()
        assembler.dispose()
        deferred.close()
        await journal.close()
      }
    }
  })

  it('preserves the captured typed usage limit through catch-up and the next reply', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const frames = await recording('opencode-v2-reopen-outside')
    await fixture.feed([frames[0]!])
    await chatSend(fixture, 'A:3', 'Reply with exactly the word ONE.')
    const error = z
      .object({ code: z.number(), message: z.string(), data: z.unknown() })
      .parse(frames[1]!.message.error)
    fixture.apply(
      fixture
        .lane()
        .promptFailed('A:3', new AcpAgentError(error.code, error.message, error.data), 1100)
    )
    const before = await fixture.rig.rows()
    const quota = before.find(
      (row) => row.body.kind === 'status' && row.body.failure?.kind === 'usageLimitReached'
    )!
    expect(quota).toBeDefined()
    await fixture.restart()
    const replay = frames
      .slice(3, -1)
      .map((frame) => ({ method: frame.message.method!, params: frame.message.params }))
    await catchUp(replay)
    const recovered = await fixture.rig.rows()
    expect(recovered.find((row) => row.itemId === quota.itemId)).toEqual(quota)
    expect(
      recovered.filter(
        (row) => row.body.kind === 'status' && row.body.failure?.kind === 'usageLimitReached'
      )
    ).toHaveLength(1)
    expect(dividers(recovered)).toHaveLength(0)
    await catchUp(replay)
    expect(await fixture.rig.rows()).toEqual(recovered)
    await chatSend(fixture, 'next:4', 'next')
    await fixture.feed([
      {
        direction: 'out',
        process: 'next',
        message: {
          id: 4,
          method: 'session/prompt',
          params: { sessionId: NAMESPACE, prompt: [{ type: 'text', text: 'next' }] }
        }
      },
      {
        direction: 'in',
        process: 'next',
        message: { method: 'session/update', params: answerReplay('NEXT', 'next-answer').params }
      },
      { direction: 'in', process: 'next', message: { id: 4, result: { stopReason: 'end_turn' } } }
    ])
    expect(JSON.stringify(await fixture.rig.rows())).toContain('NEXT')
    expect((await fixture.rig.turns()).at(-1)?.state).toBe('completed')
  })

  const scenarios = [
    { name: 'fresh identical', initial: null, middle: 'full', final: 'full' },
    { name: 'fresh differing', initial: null, middle: 'middle', final: 'full tail', rich: true },
    { name: 'held identical', initial: 'full', middle: 'full', final: 'full' },
    { name: 'held prefix', initial: 'prefix', middle: 'middle', final: 'full' },
    { name: 'held final', initial: 'full', middle: 'middle', final: 'full' },
    { name: 'unique control', initial: null, middle: 'full', final: 'full', unique: true },
    { name: 'old divider', initial: 'prefix', middle: 'prefix', final: 'prefix', old: true }
  ]
  it.each(scenarios)('settles $name without a notice across reopens', async (scenario) => {
    const { fixture, catchUp, warn } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    const rig = fixture.rig
    await chatSend(fixture, 'retained', 'keep')
    for (const body of [
      {
        kind: 'status',
        ...agentSessionFailureWords(agentSessionFailureFact('hostFault'), { surface: 'row' })
      },
      { kind: 'tool-call', name: 'native-tool', input: {}, state: 'completed' }
    ] as const) {
      await rig.journal.appendItem(
        { provider: 'legacy', agent: AGENT, sessionId: SESSION, recordId: body.kind },
        body,
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    const native = structuredClone(await rig.rows())
    const a = (text: string) => [userReplay('A', 'alpha'), answerReplay(text, 'answer-A')]
    if (scenario.initial) {
      await catchUp(a(scenario.initial))
    }
    if (scenario.old) {
      await rig.journal.appendItem(
        { provider: 'legacy', agent: AGENT, sessionId: SESSION, recordId: 'continued-outside:A' },
        continuedOutsideNotice(true),
        { fence: 1, turnScope: { kind: 'thread' } }
      )
      await rig.journal.appendItem(
        { provider: 'legacy', agent: AGENT, sessionId: SESSION, recordId: 'continued-outside:B' },
        { kind: 'status', presentation: 'history-loaded', text: 'Saved replay notice' },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    const before = structuredClone(await rig.rows())
    const tool = (id: string) => [
      replayUpdate('tool_call', {
        toolCallId: id,
        title: id,
        rawInput: { command: id },
        status: 'pending'
      }),
      replayUpdate('tool_call_update', {
        toolCallId: id,
        status: 'completed',
        rawOutput: 'done',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }]
      })
    ]
    let replay = [
      ...a(scenario.middle),
      ...(scenario.rich
        ? [
            answerReplay('earlier only', 'earlier'),
            replayUpdate('agent_thought_chunk', {
              messageId: 'thought',
              content: { type: 'text', text: 'earlier reasoning' }
            }),
            ...tool('earlier-tool')
          ]
        : []),
      userReplay('B', 'beta'),
      answerReplay('bee', 'answer-B'),
      ...(scenario.unique
        ? []
        : scenario.rich
          ? [
              userReplay('A', 'alpha'),
              answerReplay('full ', 'answer-A'),
              ...tool('final-tool'),
              answerReplay('tail', 'answer-A')
            ]
          : a(scenario.final))
    ]
    const create = historyBatch.createHistoryCatchUpBatch
    const plans: historyBatch.HistoryCatchUpPlan[] = []
    vi.spyOn(historyBatch, 'createHistoryCatchUpBatch').mockImplementation(() => {
      const batch = create()
      const finish = batch.finish
      batch.finish = (...args) => {
        const plan = finish(...args)
        plans.push(plan)
        return plan
      }
      return batch
    })
    let first: AgentJournalRenderItem[] = []
    for (const opening of [1, 2]) {
      const journal = await rig.reopenJournal()
      const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
      const publish = vi.fn()
      deferred.bind({ journal, fence: 1, publish })
      const append = deferred.sink.tryAppendTransition!
      const resolved: string[] = []
      const sink = {
        ...deferred.sink,
        tryAppendTransition: (transition: Parameters<typeof append>[0]) => {
          const admission = append({
            ...transition,
            steps: transition.steps.map((step) =>
              step.kind !== 'settlement'
                ? step
                : {
                    ...step,
                    resolve: (current) => {
                      const mutations = step.resolve(current)
                      resolved.push(...mutations.map(journalLifecycleMutationItemId))
                      return mutations
                    }
                  }
            )
          })
          expect(admission.accepted).toBe(true)
          return admission
        }
      }
      plans.length = 0
      const saved = new Map(journal.snapshot().items.map((row) => [row.itemId, row]))
      try {
        await catchUpAcpHistory({
          frames: replay,
          identity: 'user-message-id',
          sink,
          sessionId: SESSION,
          agent: AGENT,
          providerSessionId: NAMESPACE,
          dialect: OPENCODE_ACP_DIALECT,
          assertCurrent: () => {},
          logger: { warn, error: vi.fn() }
        })
        expect(await deferred.drained()).toEqual({ ok: true })
        const rows = journal.snapshot().items
        expect(rows.slice(0, native.length)).toEqual(native)
        expect(dividers(rows)).toHaveLength(0)
        expect(new Set(resolved).size).toBe(resolved.length)
        for (const plan of plans) {
          expect(new Set(plan.keys).size).toBe(plan.keys.length)
          const expected = plan.expectedItems ?? []
          expect(new Set(expected.map((item) => item.key)).size).toBe(expected.length)
          expect(expected.map((item) => item.key).sort()).toEqual(
            plan.keys.filter((key) => saved.has(key)).sort()
          )
          for (const item of expected) {
            expect(item.revision).toBe(saved.get(item.key)?.revision)
          }
        }
        if (opening === 1) {
          expect(resolved.length).toBeGreaterThan(0)
          expect(publish).toHaveBeenCalled()
          const messages = rows.filter((row) => row.body.kind === 'message')
          const byText = (text: string) =>
            messages.filter(
              (row) =>
                row.body.kind === 'message' &&
                row.body.blocks.some((block) => block.type === 'text' && block.text === text)
            )
          expect(byText('beta')).toHaveLength(1)
          expect(byText('bee')).toHaveLength(1)
          expect(byText('alpha')).toHaveLength(1)
          expect(byText(scenario.final)).toHaveLength(1)
          expect(rows.indexOf(byText('alpha')[0]!)).toBeLessThan(rows.indexOf(byText('beta')[0]!))
          expect(rows.indexOf(byText(scenario.final)[0]!)).toBeLessThan(
            rows.indexOf(byText('beta')[0]!)
          )
          for (const held of before.filter((row) => row.body.kind !== 'status')) {
            const current = rows.find((row) => row.itemId === held.itemId)!
            expect(current).toMatchObject({
              sequence: held.sequence,
              turnScope: held.turnScope,
              revision:
                held.revision + (JSON.stringify(held.body) === JSON.stringify(current.body) ? 0 : 1)
            })
            if (JSON.stringify(held.body) === JSON.stringify(current.body)) {
              expect(resolved).not.toContain(held.itemId)
            }
          }
          if (scenario.rich) {
            expect(byText('earlier only')).toHaveLength(1)
            expect(byText('earlier reasoning')).toHaveLength(1)
            for (const id of ['earlier-tool', 'final-tool']) {
              expect(
                rows.filter(
                  (row) =>
                    row.body.kind === 'tool-call' &&
                    row.body.callId === id &&
                    row.body.state === 'completed'
                )
              ).toMatchObject([
                { body: { input: { command: id }, output: { head: 'done', truncated: false } } }
              ])
            }
          }
          if (scenario.old) {
            const old = before.find(
              (row) =>
                row.body.kind === 'status' && row.body.presentation === 'continued-outside-rewound'
            )!
            const corrected = rows.find((row) => row.itemId === old.itemId)
            expect(corrected).toBeUndefined()
            // The same imported target can subsequently acquire its missing tail without a new boundary.
            replay = [
              ...a('prefix and tail'),
              userReplay('B', 'beta'),
              answerReplay('bee', 'answer-B'),
              ...a('prefix and tail')
            ]
            await catchUpAcpHistory({
              frames: replay,
              identity: 'user-message-id',
              sink,
              sessionId: SESSION,
              agent: AGENT,
              providerSessionId: NAMESPACE,
              dialect: OPENCODE_ACP_DIALECT,
              assertCurrent: () => {}
            })
            expect(dividers(journal.snapshot().items)).toHaveLength(0)
            expect(
              journal
                .snapshot()
                .items.filter(
                  (row) =>
                    row.body.kind === 'message' &&
                    row.body.role === 'assistant' &&
                    row.body.blocks.some(
                      (block) => block.type === 'text' && block.text === 'prefix and tail'
                    )
                )
            ).toHaveLength(1)
          }
          first = structuredClone(journal.snapshot().items)
        } else {
          expect(plans).toEqual([])
          expect(resolved).toEqual([])
          expect(publish).not.toHaveBeenCalled()
          expect(rows).toEqual(first)
        }
        expect(warn).not.toHaveBeenCalled()
      } finally {
        deferred.close()
        await journal.close()
      }
    }
  })

  it('abandons an old-notice correction if its saved revision changes before commit', async () => {
    const { fixture, catchUp } = await setup(OPENCODE_ACP_DIALECT, 'user-message-id')
    await chatSend(fixture, 'retained', 'keep')
    const replay = [userReplay('recovered'), answerReplay('answer')]
    await catchUp(replay)
    const identity = {
      provider: 'legacy',
      agent: AGENT,
      sessionId: SESSION,
      recordId: 'continued-outside:recovered'
    } as const
    await fixture.rig.journal.appendItem(identity, continuedOutsideNotice(true), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    const append = fixture.rig.eventSink.tryAppendTransition!
    fixture.rig.eventSink.tryAppendTransition = (transition) => {
      void fixture.rig.journal.appendItem(identity, continuedOutsideNotice(false), {
        fence: 1,
        turnScope: { kind: 'thread' }
      })
      return append(transition)
    }
    const full = [...replay, userReplay('B', 'beta'), answerReplay('bee', 'answer-B')]
    await catchUp(full)
    fixture.rig.eventSink.tryAppendTransition = append
    const rows = await fixture.rig.rows()
    expect(rows.find((row) => row.body.kind === 'status')?.body).toEqual(
      continuedOutsideNotice(false)
    )
    expect(JSON.stringify(rows)).not.toContain('bee')
    await catchUp(full)
    const settled = await fixture.rig.rows()
    expect(JSON.stringify(settled)).toContain('bee')
    expect(dividers(settled)).toHaveLength(0)
    const journal = await fixture.rig.reopenJournal()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const appendReopened = vi.spyOn(deferred.sink, 'tryAppendTransition')
    try {
      await catchUpAcpHistory({
        frames: full,
        identity: 'user-message-id',
        sink: deferred.sink,
        sessionId: SESSION,
        agent: AGENT,
        providerSessionId: NAMESPACE,
        dialect: OPENCODE_ACP_DIALECT,
        assertCurrent: () => {}
      })
      expect(await deferred.drained()).toEqual({ ok: true })
      expect(appendReopened).not.toHaveBeenCalled()
      expect(journal.snapshot().items).toEqual(settled)
    } finally {
      deferred.close()
      await journal.close()
    }
  })
})
