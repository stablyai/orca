import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { StructuredAgentSessionCommandRun } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { acpStructuredAgentDefinition } from '../session/acp-structured-agent-definitions'
import { GrokFixtureReplay } from '../session/testing/acp-structured-fixture-replay.test-support'
import type { AcpFixtureFrame } from '../timeline/testing/acp-timeline-fixture.test-support'
import {
  GROK,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from '../session/testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

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
  it('runs Antigravity compact only while the current session reports the command', async () => {
    const spec = ANTIGRAVITY_LAUNCH_SPEC.hostBackend.spec
    const rig = await openAcpAdapterRig({ spec })
    const registry = new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(ANTIGRAVITY_LAUNCH_SPEC), adapter: rig.adapter }
    ])
    await rig.acquire()
    const agent = rig.child().agent
    const supported = () => registry.capabilities('antigravity', SESSION)?.compact
    const report = (availableCommands: { name: string; description: string }[]) =>
      agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: { sessionUpdate: 'available_commands_update', availableCommands }
      })
    expect(supported()).toBe(false)
    report([{ name: 'compact', description: 'Compact the conversation now' }])
    await waitFor(async () => expect(supported()).toBe(true))
    expect(registry.capabilities('antigravity', 'another-session')?.compact).toBe(false)
    const command = await commandRun(rig)
    await rig.adapter.compact({ sessionId: SESSION, fence: 1, command })
    const prompt = await rig.frame('session/prompt')
    expect(prompt.params).toMatchObject({ prompt: [{ type: 'text', text: '/compact' }] })
    agent.reply(prompt, { stopReason: 'end_turn' })
    expect((await ended(rig, command)).turn).toMatchObject({ outcome: 'success' })
    report([])
    await waitFor(async () => expect(supported()).toBe(false))
  })

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

  it('ends a stopped compaction as cancelled, with no result row', async () => {
    const { rig, command, prompt } = await compact(GROK)
    const { agent } = rig.child()
    agent.on('session/cancel', () => agent.reply(prompt, { stopReason: 'cancelled' }))
    await expect(
      rig.adapter.cancelTurn({
        sessionId: SESSION,
        fence: 1,
        turnId: command.turnId,
        resolveLiveTurnId: async () => command.turnId
      })
    ).resolves.toEqual({ cancelled: true })
    const { turn, inside } = await ended(rig, command)
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(inside).toEqual([])
  })
})
