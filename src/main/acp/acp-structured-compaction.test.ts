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
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/providers/structured-agent-registry'
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

async function compact(spec: AcpLaunchSpec, frames?: AcpFixtureFrame[], instructions?: string) {
  const rig = await openAcpAdapterRig({ spec })
  new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(spec), adapter: rig.adapter }
  ])
  await rig.acquire()
  if (frames) {
    new GrokFixtureReplay(frames).attach(rig.child().agent)
  }
  const command = { ...(await commandRun(rig)), ...(instructions ? { instructions } : {}) }
  expect(await rig.adapter.compact({ sessionId: SESSION, fence: 1, command })).toEqual({
    state: 'accepted',
    providerIdentity: null
  })
  return { rig, command, prompt: await rig.frame('session/prompt') }
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

  it.each([
    { cause: 'recorded provider APIError', errorName: 'APIError', item: 'turn-failure' },
    {
      cause: 'local unsupported-operation',
      errorName: 'provider.unsupported-operation',
      item: 'compaction'
    }
  ])(
    "fails a compaction OpenCode answered with its $cause, in the agent's words",
    async ({ errorName, item }) => {
      const { rig, command, prompt } = await compact(OPENCODE)
      const recorded = (await readAcpFixture('opencode-v1-provider-error')).find(
        (frame) => frame.message.error !== undefined
      )
      const error = z
        .object({ code: z.number(), message: z.string(), data: z.looseObject({}) })
        .parse(recorded?.message.error)
      // The recorded error carries APIError; the local case swaps in OpenCode's local error name.
      rig.child().agent.fail(prompt, error.code, error.message, { ...error.data, errorName })
      const { turn } = await ended(rig, command)
      expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
      const text = 'Internal error: CAPTURE_PROVIDER_400'
      expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([
        expect.objectContaining({
          // The saved provider item id encodes its `item:turn` key twice.
          itemId: expect.stringContaining(
            encodeURIComponent(encodeURIComponent(`${item}:${command.turnId}`))
          ),
          turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(command.identity) },
          body:
            errorName === 'APIError'
              ? { kind: 'status', tone: 'error', text }
              : expect.objectContaining({
                  tone: 'error',
                  failure: { kind: 'compactionFailed', detail: { text, audience: 'person' } }
                })
        })
      ])
    }
  )

  it("reads Grok's rate-limit RPC code as one usage failure, ignoring its late notification", async () => {
    const { rig, command, prompt } = await compact(GROK)
    const { agent } = rig.child()
    // Grok keeps its 429 code inside the compact error wrapper; a producer shape, not a live capture.
    agent.fail(prompt, -32003, 'Internal error', {
      kind: 'compact_failed',
      message: 'Rate limited'
    })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    agent.notify('_x.ai/session/prompt_complete', {
      sessionId: PROVIDER_SESSION,
      promptId: command.turnId,
      stopReason: 'rate_limit',
      agentResult: 'Late cause'
    })
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'next',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] },
      fence: 1
    })
    agent.reply(await rig.frame('session/prompt', 1), { stopReason: 'end_turn' })
    await waitFor(async () => expect(await rig.rig.turns()).toHaveLength(2))
    const usage = expect.objectContaining({
      tone: 'warning',
      failure: {
        kind: 'usageLimitReached',
        detail: { text: 'Rate limited', audience: 'person' }
      }
    })
    expect(inside).toEqual([usage])
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'status')).toEqual([
      expect.objectContaining({ body: usage })
    ])
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

  it('says OMP has no model selected, as a send does', async () => {
    // OMP says this both signed out and for a launch selector it never resolved.
    const { rig, command, prompt } = await compact(OMP)
    rig.child().agent.fail(prompt, -32603, 'Internal error', {
      details: 'No model selected.\n\nUse /login to sign in.'
    })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        tone: 'error',
        failure: expect.objectContaining({ kind: 'modelNotSelected' })
      })
    ])
    // The agent's own failure, so cards waiting behind the compaction stay held.
    expect(rig.rig.journal.inputOrder.newestTurn.failure()).toBeGreaterThan(0)
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
})
