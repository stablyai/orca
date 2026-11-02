import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { structuredAgentSessionCommandTurn } from '../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { acpLaunchSpecFor, type AcpLaunchSpec } from './acp-launch-specs'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import { GrokFixtureReplay } from './acp-structured-fixture-replay.test-support'
import { readAcpFixture, type AcpFixtureFrame } from './acp-timeline-fixture.test-support'
import {
  GROK,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const OPENCODE = acpLaunchSpecFor('opencode')!
const OMP = acpLaunchSpecFor('omp')!

async function commandRun(rig: AcpAdapterRig): Promise<StructuredAgentSessionCommandRun> {
  const turn = structuredAgentSessionCommandTurn('compact-1')
  const running = agentJournalTurnBody({ turnId: turn.turnId, state: 'running', startedAt: 4_000 })
  await rig.rig.journal.appendItem(turn.identity, running, {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  return { clientMessageId: 'compact-1', ...turn, running }
}

async function compact(spec: AcpLaunchSpec, frames?: AcpFixtureFrame[]) {
  const rig = await openAcpAdapterRig({ spec })
  new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(spec), adapter: rig.adapter }
  ])
  await rig.acquire()
  if (frames) {
    new GrokFixtureReplay(frames).attach(rig.child().agent)
  }
  const command = await commandRun(rig)
  expect(await rig.adapter.compact({ sessionId: SESSION, fence: 1, command })).toEqual({
    state: 'accepted',
    providerIdentity: null
  })
  return { rig, command, prompt: await rig.frame('session/prompt') }
}

function replyText(text: string, promptId?: string) {
  return {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    ...(promptId ? { _meta: { promptId } } : {})
  }
}

async function ended(rig: AcpAdapterRig, command: StructuredAgentSessionCommandRun) {
  return waitFor(async () => {
    const rows = await rig.rig.rows()
    const turn = readAgentJournalTurn(
      rows.find((row) => row.itemId === agentJournalItemKey(command.identity))?.body
    )
    expect(turn).toEqual(expect.objectContaining({ turnId: command.turnId }))
    expect(turn?.state).not.toBe('running')
    const inside = rows.filter(
      (row) =>
        row.turnScope?.kind === 'turn' &&
        row.turnScope.turnItemId === agentJournalItemKey(command.identity)
    )
    return { turn, inside: inside.map((row) => row.body) }
  })
}

describe('ACP compaction request', () => {
  it("sends Grok `/compact` as a prompt under the command turn's id", async () => {
    const { command, prompt } = await compact(GROK)
    expect(prompt.params).toEqual({
      sessionId: PROVIDER_SESSION,
      prompt: [{ type: 'text', text: '/compact' }],
      _meta: { promptId: command.turnId, requestId: command.turnId }
    })
  })

  it.each([
    ['OpenCode', OPENCODE],
    ['OMP', OMP]
  ])('sends %s `/compact` as a plain prompt', async (_name, spec) => {
    const { prompt } = await compact(spec)
    expect(prompt.params).toEqual({
      sessionId: PROVIDER_SESSION,
      prompt: [{ type: 'text', text: '/compact' }]
    })
  })
})

describe('ACP compaction settlement', () => {
  it.each([
    [
      'omp-v17-compact-skip',
      {
        kind: 'status',
        tone: 'warning',
        text: 'Nothing to compact (session too small)',
        presentation: 'compaction-skipped'
      }
    ],
    [
      'omp-v17-compact-success',
      { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    ]
  ])('replays captured %s under the host command turn', async (fixture, body) => {
    const frames = await readAcpFixture(fixture)
    const { rig, command } = await compact(OMP, frames)
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'success' })
    expect(inside).toEqual([body])
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'message')).toBe(false)
  })

  it('ends a compaction the agent finished with one compacted row, drawing none of its words', async () => {
    const { rig, command, prompt } = await compact(GROK)
    const { agent } = rig.child()
    agent.notify('session/update', replyText('Summarised 40 messages.', command.turnId))
    agent.reply(prompt, { stopReason: 'end_turn' })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ turnId: command.turnId, state: 'completed', outcome: 'success' })
    expect(inside).toEqual([
      { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    ])
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'message')).toBe(false)
  })

  it('reads OMP Already compacted as skipped, not failed', async () => {
    const { rig, command, prompt } = await compact(OMP)
    const { agent } = rig.child()
    agent.notify('session/update', replyText('Compaction failed: Already compacted'))
    agent.reply(prompt, { stopReason: 'end_turn' })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'success' })
    expect(inside).toEqual([
      {
        kind: 'status',
        tone: 'warning',
        text: 'Already compacted',
        presentation: 'compaction-skipped'
      }
    ])
  })

  it('reads any other OMP compaction failure as failed, in its own words', async () => {
    const { rig, command, prompt } = await compact(OMP)
    const { agent } = rig.child()
    agent.notify(
      'session/update',
      replyText('Compaction failed: summary model rejected the request')
    )
    agent.reply(prompt, { stopReason: 'end_turn' })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        kind: 'status',
        tone: 'error',
        failure: expect.objectContaining({
          kind: 'compactionFailed',
          detail: {
            text: 'Compaction failed: summary model rejected the request',
            audience: 'person'
          }
        })
      })
    ])
  })

  it('reads OMP failure words only from OMP', async () => {
    const { rig, command, prompt } = await compact(OPENCODE)
    const { agent } = rig.child()
    agent.notify('session/update', replyText('Compaction failed: Nothing to compact'))
    agent.reply(prompt, { stopReason: 'end_turn' })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ outcome: 'success' })
    expect(inside).toEqual([
      { kind: 'status', text: 'Context compacted', presentation: 'compaction' }
    ])
  })

  it("fails a compaction the agent answered with an error, in the agent's words", async () => {
    const { rig, command, prompt } = await compact(OPENCODE)
    const recorded = (await readAcpFixture('opencode-v1-provider-error')).find(
      (frame) => frame.message.error !== undefined
    )
    const error = z
      .object({ code: z.number(), message: z.string(), data: z.unknown() })
      .parse(recorded?.message.error)
    rig.child().agent.fail(prompt, error.code, error.message, error.data)
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        tone: 'error',
        failure: {
          kind: 'compactionFailed',
          detail: { text: 'Internal error: CAPTURE_PROVIDER_400', audience: 'person' }
        }
      })
    ])
  })

  it("keeps Grok's own no-work compaction error the command's failure, not the agent's", async () => {
    const { rig, command, prompt } = await compact(GROK)
    // Grok's documented compact error data; a supported producer shape, not a live capture.
    rig.child().agent.fail(prompt, -32603, 'Internal error', {
      kind: 'compact_failed',
      message: 'nothing to compact'
    })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        tone: 'error',
        failure: {
          kind: 'compactionFailed',
          detail: { text: 'nothing to compact', audience: 'person' }
        }
      })
    ])
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toHaveLength(1)
  })

  it.each(['turn_completed', 'prompt_complete'])(
    'retains Grok quota classification from %s before its generic RPC error',
    async (source) => {
      const { rig, command, prompt } = await compact(GROK)
      const { agent } = rig.child()
      // Existing captured failure ordering; the reduced prompt-complete case has no diagnostic.
      if (source === 'turn_completed') {
        agent.notify('_x.ai/session_notification', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'retry_state',
            type: 'failed',
            error_type: 'api',
            message: 'API failure'
          },
          _meta: { agentTimestampMs: 1 }
        })
        agent.notify('_x.ai/session_notification', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: command.turnId,
            stop_reason: 'rate_limit',
            elapsed_ms: 729
          }
        })
      }
      agent.notify('_x.ai/session/prompt_complete', {
        sessionId: PROVIDER_SESSION,
        promptId: command.turnId,
        stopReason: 'rate_limit',
        agentResult: null
      })
      agent.fail(prompt, -32603, 'Internal error')
      const { turn, inside } = await ended(rig, command)
      expect(turn).toMatchObject({ outcome: 'failure' })
      expect(inside).toEqual([
        expect.objectContaining({
          kind: 'status',
          tone: 'warning',
          failure: {
            kind: 'usageLimitReached',
            detail: {
              text: source === 'turn_completed' ? 'API failure' : 'Internal error',
              audience: 'person'
            }
          }
        })
      ])
      expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toHaveLength(1)
    }
  )

  it('preserves OpenCode quota reset metadata in one ordinary failure row in the command turn', async () => {
    const { rig, command, prompt } = await compact(OPENCODE)
    const resetsAt = 65_000
    rig.child().agent.fail(prompt, -32603, 'Rate limit exceeded. Please try again later.', {
      service: 'session',
      errorName: 'provider.rate-limit',
      retryAfterMs: 60_000
    })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        tone: 'warning',
        failure: expect.objectContaining({ kind: 'usageLimitReached', usageLimit: { resetsAt } })
      })
    ])
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toHaveLength(1)
  })

  it('keeps a no-detail rate-limit result distinct from a command refusal', async () => {
    const { rig, command, prompt } = await compact(GROK)
    rig.child().agent.reply(prompt, { stopReason: 'rate_limit' })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ outcome: 'failure' })
    expect(inside).toEqual([expect.objectContaining({ failure: { kind: 'usageLimitReached' } })])
  })

  it('ignores named late compaction failures after another prompt settles, preserving its original scope', async () => {
    const { rig, command, prompt } = await compact(GROK)
    const { agent } = rig.child()
    agent.fail(prompt, -32603, 'Provider failed')
    const original = await ended(rig, command)
    for (const [index, clientMessageId] of ['next', 'barrier'].entries()) {
      if (index === 1) {
        agent.notify('_x.ai/session/prompt_complete', {
          sessionId: PROVIDER_SESSION,
          promptId: command.turnId,
          stopReason: 'rate_limit',
          agentResult: 'Late cause'
        })
        agent.notify('_x.ai/session_notification', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: command.turnId,
            stop_reason: 'rate_limit'
          }
        })
      }
      await rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
        fence: 1
      })
      agent.reply(await rig.frame('session/prompt', index + 1), { stopReason: 'end_turn' })
      await waitFor(async () => {
        const turns = await rig.rig.turns()
        expect(turns).toHaveLength(index + 2)
        expect(turns.at(-1)).toMatchObject({ outcome: 'success' })
      })
    }
    expect((await ended(rig, command)).inside).toEqual(original.inside)
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toHaveLength(1)
  })

  it.each([
    { spec: OPENCODE, code: -32000, data: undefined },
    { spec: OMP, code: -32603, data: { details: 'No model selected.\n\nUse /login to sign in.' } }
  ])('says $spec.agent is not signed in, as a send does', async ({ spec, code, data }) => {
    const { rig, command, prompt } = await compact(spec)
    rig.child().agent.fail(prompt, code, 'Authentication required', data)
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        tone: 'error',
        failure: expect.objectContaining({ kind: 'notSignedIn' })
      })
    ])
  })

  it('fails a compaction the agent ended with any other stop reason', async () => {
    const { rig, command, prompt } = await compact(GROK)
    rig.child().agent.reply(prompt, { stopReason: 'refusal' })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({ failure: expect.objectContaining({ kind: 'compactionFailed' }) })
    ])
  })

  it('ends a stopped compaction as cancelled, with no result row', async () => {
    const { rig, command, prompt } = await compact(GROK)
    const { agent } = rig.child()
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await expect(
      rig.adapter.cancelTurn({
        sessionId: SESSION,
        fence: 1,
        turnId: command.turnId,
        resolveLiveTurnId: () => command.turnId
      })
    ).resolves.toEqual({ cancelled: true })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(inside).toEqual([])
  })

  it('takes the next message as an ordinary turn once the compaction ended', async () => {
    const { rig, command, prompt } = await compact(GROK)
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await ended(rig, command)
    expect(
      await rig.adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'send-2',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] },
        fence: 1
      })
    ).toEqual({ state: 'admitted' })
    expect((await rig.frame('session/prompt', 1)).params).toMatchObject({
      prompt: [{ type: 'text', text: 'next' }],
      _meta: { promptId: 'prompt:send-2' }
    })
  })
})
