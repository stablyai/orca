import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { structuredSessionBackgroundTasksView } from '../../shared/structured-session-background-tasks-view'
import { isSubagentBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { GENERIC_ACP_DIALECT, type AcpDialect } from './acp-dialects/acp-dialect'
import {
  acpChildWorkStatusSink,
  acpSubagentRecords
} from './acp-structured-child-work.test-support'
import { PROVIDER_SESSION, replyChunk } from './acp-structured-adapter.test-support'
import { openAttachedHostRig, promptIdOf, send, stop } from './acp-structured-host.test-support'
import { readAcpFixture } from './acp-timeline-fixture.test-support'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) {
    await close()
  }
  await closeProviderTimelineRigs()
})

function translator(dialect: AcpDialect = GROK_ACP_DIALECT) {
  const lane = new AcpTimelineTranslator({ sessionId: PROVIDER_SESSION, dialect })
  const { promptId } = lane.openPrompt('parent', 100)
  lane.notification('session/update', replyChunk(promptId, 'Parent running'), 101)
  lane.notification(
    '_x.ai/session_notification',
    {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'subagent_spawned',
        subagent_id: 'child',
        parent_prompt_id: promptId,
        description: 'Original label'
      }
    },
    102
  )
  const records = acpSubagentRecords()
  const host = () => records(lane.subagents.drainEvidence())
  host()
  const end = (
    reason: string,
    sessionId = 'child',
    meta = {},
    method = '_x.ai/session_notification'
  ) =>
    lane.notification(
      method,
      {
        sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'child-turn',
          stop_reason: reason,
          usage: { inputTokens: 99999 },
          elapsed_ms: 20
        },
        _meta: meta
      },
      120
    )
  return { lane, end, host, promptId }
}

describe('owned Grok child-session completion', () => {
  it.each([
    'session/update',
    '_x.ai/session_notification',
    'x.ai/session_notification',
    '_x.ai/session/update'
  ])('settles a known child through %s without ending or charging the parent turn', (method) => {
    const f = translator()
    expect(f.end('end_turn', 'child', {}, method)).toEqual([])
    expect(f.host()).toMatchObject([
      {
        providerId: 'child',
        description: 'Original label',
        membership: 'settled',
        outcome: 'succeeded'
      }
    ])
    expect(f.end('cancelled')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'succeeded' }])
    const parent = f.lane.notification(
      'session/update',
      replyChunk(f.promptId, 'Parent continues'),
      121
    )
    expect(parent.some((event) => event.type === 'turn.open' || event.type === 'turn.end')).toBe(
      false
    )
    expect(f.lane.promptResult('parent', { stopReason: 'end_turn' }, 122)).toMatchObject([
      { type: 'turn.end', turn: f.promptId, outcome: 'success' }
    ])
  })

  it('latches cancellation against conflicting child ends, parent reports and later working progress', () => {
    const f = translator()
    expect(f.end('cancelled')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'cancelled' }])
    expect(f.end('end_turn')).toEqual([])
    expect(
      f.lane.notification(
        '_x.ai/session_notification',
        {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'failed' }
        },
        121
      )
    ).toEqual([])
    const progress = f.lane.notification(
      '_x.ai/session_notification',
      {
        sessionId: PROVIDER_SESSION,
        update: { sessionUpdate: 'subagent_progress', subagent_id: 'child', tokens_used: 7 }
      },
      122
    )
    expect(progress).toEqual([])
    expect(f.host()).toMatchObject([
      { providerId: 'child', membership: 'settled', outcome: 'cancelled' }
    ])
  })

  it('ignores unknown reasons and unowned sessions without creating a child or changing the parent', () => {
    const f = translator()
    expect(f.end('future_stop_reason')).toEqual([])
    expect(f.end('cancelled', 'unowned-child')).toEqual([])
    expect(f.end('cancelled', 'child', {}, '_x.ai/other_notification')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
    expect(f.lane.promptResult('parent', { stopReason: 'end_turn' }, 122)).toMatchObject([
      { type: 'turn.end', turn: f.promptId, outcome: 'success' }
    ])
  })

  it('drops child messages, turn starts and usage instead of opening a child turn in the parent', () => {
    const f = translator()
    for (const update of [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child text' } },
      { sessionUpdate: 'response_completed', usage: { input_tokens: 99999 } },
      { sessionUpdate: 'turn_started', prompt_id: 'child-turn' }
    ]) {
      expect(
        f.lane.notification('_x.ai/session_notification', { sessionId: 'child', update }, 120)
      ).toEqual([])
    }
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
    expect(f.end('end_turn')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'succeeded' }])
  })

  it('ignores malformed completions and child-scoped roster reports without learning a new child', () => {
    const f = translator()
    for (const update of [
      { sessionUpdate: 'turn_completed', stop_reason: 'cancelled' },
      { sessionUpdate: 'turn_completed', prompt_id: 'child-turn', stop_reason: null },
      { sessionUpdate: 'subagent_spawned', subagent_id: 'nested-child' },
      { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'cancelled' }
    ]) {
      expect(
        f.lane.notification('_x.ai/session_notification', { sessionId: 'child', update }, 120)
      ).toEqual([])
    }
    expect(f.end('cancelled', 'nested-child')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
    expect(f.end('end_turn')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'succeeded' }])
  })

  it('ignores replay and loading even when a loading notice explicitly says it is live', () => {
    const f = translator()
    expect(f.end('cancelled', 'child', { isReplay: true })).toEqual([])
    f.lane.promptResult('parent', { stopReason: 'end_turn' }, 110)
    f.lane.beginLoad()
    expect(f.end('cancelled')).toEqual([])
    expect(f.end('cancelled', 'child', { isReplay: false })).toEqual([])
    f.lane.finishLoad()
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
    expect(f.end('end_turn')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', outcome: 'succeeded' }])
    f.lane.dispose()
    expect(f.end('cancelled')).toEqual([])
  })

  it('keeps the foreign-session fence for another dialect even when its parent reports subagents', () => {
    const f = translator({
      ...GENERIC_ACP_DIALECT,
      notification: GROK_ACP_DIALECT.notification
    })
    expect(f.end('cancelled')).toEqual([])
    expect(f.host()).toMatchObject([{ providerId: 'child', membership: 'live' }])
  })
})

describe('recorded child-session outcome during a full parent Stop', () => {
  it.each([
    ['cancelled', 'stopped', 'cancelled'],
    ['future_stop_reason', 'unverifiable', 'unknown']
  ] as const)(
    'preserves the %s child outcome through the parent result and shutdown sweep',
    async (reason, state, outcome) => {
      const childWork = acpChildWorkStatusSink()
      const hosted = await openAttachedHostRig({ now: () => Date.now() }, childWork.sink)
      cleanup.push(async () => {
        hosted.rig.child().exit()
        await hosted.host.close(SESSION, 'user-close')
      })
      await send(hosted.host, 'Run two background children')
      const prompt = await hosted.rig.frame('session/prompt')
      const child = hosted.rig.child()
      const agent = child.agent
      const frames = await readAcpFixture('s8-subagent-parent-stop')
      const notices = frames
        .filter((frame) => frame.direction === 'in' && frame.message.method)
        .map(({ message }) => ({
          method: message.method ?? '',
          params: z
            .looseObject({
              sessionId: z.string(),
              update: z.looseObject({ sessionUpdate: z.string() })
            })
            .parse(
              JSON.parse(
                JSON.stringify(message.params).replaceAll(
                  'prompt:recorded-parent',
                  promptIdOf(prompt)
                )
              )
            )
        }))
      const [spawnFirst, spawnSecond, selectedFinished, childEnded, parentEnded] = notices
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(1791496672056)
      agent.notify('session/update', replyChunk(promptIdOf(prompt), 'Both children running'))
      agent.notify(spawnFirst.method, spawnFirst.params)
      vi.setSystemTime(1791496672060)
      agent.notify(spawnSecond.method, spawnSecond.params)
      await hosted.rows()
      vi.setSystemTime(1791496678726)
      agent.notify(selectedFinished.method, selectedFinished.params)
      const subagents = async () =>
        (await hosted.rows()).flatMap((row) =>
          row.body.kind === 'message'
            ? row.body.blocks.filter(isSubagentBlock).map((block) => ({ row, block }))
            : []
        )
      const original = await subagents()
      expect(original.map(({ block }) => block)).toMatchObject([
        { id: 'subagent-1', state: 'stopped' },
        { id: 'subagent-2', state: 'working' }
      ])
      const strip = async () =>
        (await hosted.host.history({ sessionId: SESSION, direction: 'tail' })).page.backgroundTasks
      expect((await strip())?.tasks).toMatchObject([
        { id: 'subagent-2', description: 'Keep strip count', kind: 'agent' }
      ])
      vi.setSystemTime(1791496686285)
      agent.on('session/cancel', () => {
        setTimeout(
          () =>
            agent.notify(childEnded.method, {
              ...childEnded.params,
              update: { ...childEnded.params.update, stop_reason: reason }
            }),
          17
        )
        setTimeout(() => agent.notify(parentEnded.method, parentEnded.params), 18)
        setTimeout(() => agent.reply(prompt, { stopReason: 'cancelled' }), 335)
      })
      expect(await stop(hosted.host)).toMatchObject({ ok: true, value: { cancelled: true } })
      await vi.advanceTimersByTimeAsync(17)
      const beforeParentResult = await subagents()
      expect
        .soft(beforeParentResult.map(({ row }) => row.itemId))
        .toEqual(original.map(({ row }) => row.itemId))
      expect
        .soft(beforeParentResult.map(({ row }) => row.turnScope))
        .toEqual(original.map(({ row }) => row.turnScope))
      expect
        .soft(beforeParentResult.map(({ block }) => block))
        .toMatchObject([
          original[0].block,
          reason === 'cancelled' ? { id: 'subagent-2', state: 'stopped' } : original[1].block
        ])
      expect.soft((await hosted.turns()).at(-1)).toMatchObject({ state: 'running' })
      expect.soft(child.closes).toBe(0)
      if (reason === 'cancelled') {
        expect.soft(childWork.views()).toMatchObject([
          { membership: 'settled', outcome: 'cancelled' },
          { membership: 'settled', outcome: 'cancelled' }
        ])
        expect.soft(structuredSessionBackgroundTasksView(await strip(), null)).toMatchObject({
          show: true,
          isMonitoring: false,
          offersStopAll: false
        })
      }
      await vi.advanceTimersByTimeAsync(335 - 17)
      expect((await hosted.turns()).at(-1)).toMatchObject({
        state: 'interrupted',
        outcome: 'cancellation'
      })
      const settled = await subagents()
      expect(settled.map(({ block }) => block)).toMatchObject([
        { id: 'subagent-1', state: 'stopped' },
        { id: 'subagent-2', state }
      ])
      expect(childWork.views()).toMatchObject([
        { membership: 'settled', outcome: 'cancelled' },
        { membership: 'settled', outcome }
      ])
      const retained = await strip()
      expect(retained?.children).toMatchObject([
        { membership: 'settled', outcome: 'cancelled' },
        { membership: 'settled', outcome }
      ])
      expect(structuredSessionBackgroundTasksView(retained, null)).toMatchObject({
        show: true,
        isMonitoring: false,
        offersStopAll: false
      })
      expect(await hosted.turns()).toHaveLength(1)
    }
  )
})
