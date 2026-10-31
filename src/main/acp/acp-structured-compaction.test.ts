import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody, readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { structuredAgentSessionCommandTurn } from '../native-chat/agent-session-wire/structured-agent-session-command-turn'
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
    // -32000 means signed out to ACP; any other error code is the compaction's own failure.
    rig.child().agent.fail(prompt, -32603, 'Summarization failed: 500')
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(inside).toEqual([
      expect.objectContaining({
        tone: 'error',
        failure: expect.objectContaining({
          kind: 'compactionFailed',
          detail: { text: 'Summarization failed: 500', audience: 'person' }
        })
      })
    ])
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
