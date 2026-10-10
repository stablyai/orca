import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { subagentGroupJournalBody } from '../native-chat/agent-session-journal/journal-subagent-group-body'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerTurnItemId,
  refusingSink
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpStructuredLane } from './acp-structured-lane'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import {
  recordingStructuredAgentSessionLogger,
  testEventSinkLogging
} from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { AgentHookServer } from '../agent-hooks/server'

const lanes: AcpStructuredLane[] = []
afterEach(async () => {
  lanes.splice(0).forEach((lane) => lane.dispose())
  await closeProviderTimelineRigs()
})

function roster(state: 'working' | 'completed'): ProviderTimelineEvent {
  return {
    type: 'item.update',
    item: 'subagents:turn',
    body: subagentGroupJournalBody('turn', [
      { id: 'child', label: 'Exact label', state, startedAt: 1 }
    ])
  }
}

async function fixture(reason: 'backpressure' | 'failed' = 'backpressure') {
  const rig = await openProviderTimelineRig()
  const delivery: AgentChildWorkEvidence[][] = []
  const refused = { value: false }
  const failed = vi.fn()
  const lane = new AcpStructuredLane({
    sink: refusingSink(rig.sink, () => refused.value, reason),
    sessionId: 'session-timeline',
    providerSessionId: 'provider-session-1',
    agent: 'grok',
    agentName: 'Grok',
    generation: 'gen-1',
    dialect: GROK_ACP_DIALECT,
    logger: recordingStructuredAgentSessionLogger().logger,
    onInputAccepted: () => {},
    onFailed: failed,
    onChildWorkEvidence: (evidence) => delivery.push(evidence),
    now: () => 10
  })
  lanes.push(lane)
  return { rig, lane, refused, delivery, failed }
}

describe('ACP roster evidence at the ordered journal boundary', () => {
  it('does not settle host child work from a preliminary parent settlement while its roster write is refused', async () => {
    const rig = await openProviderTimelineRig()
    const server = new AgentHookServer()
    const subject = makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      'session-timeline'
    )
    server.ingestStructuredStatus(
      {
        sessionId: subject.sessionId,
        workspaceId: subject.workspaceId,
        agent: 'grok',
        status: 'working',
        hostExecutionOwned: true,
        latestPrompt: 'Delegate',
        updatedAt: 1
      },
      subject
    )
    let refuseRoster = false
    const internalSettlements = vi.fn()
    const delivery = vi.fn((evidence: AgentChildWorkEvidence[]) =>
      server.ingestStructuredChildWork(subject, evidence, 'grok')
    )
    const lane = new AcpStructuredLane({
      sink: {
        ...rig.sink,
        tryAppendTransition: (transition) => {
          if (refuseRoster && !transition.lifecycle) {
            return { accepted: false, reason: 'backpressure' }
          }
          if (refuseRoster && transition.lifecycle) {
            internalSettlements()
          }
          return rig.sink.tryAppendTransition(transition)
        }
      },
      sessionId: 'session-timeline',
      providerSessionId: 'provider-session-1',
      agent: 'grok',
      agentName: 'Grok',
      generation: 'gen-1',
      dialect: GROK_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: () => {},
      onChildWorkEvidence: delivery,
      now: () => 10
    })
    lanes.push(lane)
    lane.apply([{ type: 'turn.open', turn: 'turn', at: 1 }, roster('working')])
    await rig.rows()
    const running = await rig.turn('turn')
    const identity = parseAgentJournalItemKey(providerTurnItemId('turn'))
    if (!running || !identity) {
      throw new Error('Missing running parent turn')
    }
    await rig.journal.appendItem(
      identity,
      agentJournalTurnBody({ ...running, state: 'interrupted', completedAt: 2 }),
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    expect(lane.openTurnId).not.toBeNull()
    refuseRoster = true
    lane.apply([roster('completed')])
    const heldRows = await rig.rows()
    expect(internalSettlements).toHaveBeenCalledTimes(1)
    expect(lane.openTurnId).toBeNull()
    expect(
      heldRows.some(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks.some(
            (block) => block.type === 'subagent-group' && block.agents[0]?.state === 'working'
          )
      )
    ).toBe(true)
    expect(server.getStructuredChildWorkViews(subject)).toMatchObject([
      { membership: 'live', state: 'working' }
    ])
    expect(delivery).toHaveBeenCalledTimes(1)
    refuseRoster = false
    lane.retry()
    await rig.rows()
    expect(server.getStructuredChildWorkViews(subject)).toMatchObject([
      { membership: 'settled', outcome: 'succeeded' }
    ])
    expect(delivery).toHaveBeenCalledTimes(2)
  })
  it('delivers acquisition-time snapshots only after the journal binds and publishes the parent', async () => {
    const rig = await openProviderTimelineRig()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const sink = providerTimelineSink(deferred.sink)
    if (!sink) {
      throw new Error('Missing transition sink')
    }
    let parentPublished = false
    const delivered = vi.fn(() => expect(parentPublished).toBe(true))
    const lane = new AcpStructuredLane({
      sink,
      sessionId: 'session-timeline',
      providerSessionId: 'provider-session-1',
      agent: 'grok',
      agentName: 'Grok',
      generation: 'gen-1',
      dialect: GROK_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: () => {},
      onChildWorkEvidence: delivered
    })
    lanes.push(lane)
    lane.apply(
      lane.translator.notification(
        '_x.ai/session/update',
        {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'subagent_spawned',
            subagent_id: 'child',
            description: 'Exact label'
          }
        },
        1
      )
    )
    lane.apply(
      lane.translator.notification(
        '_x.ai/session/update',
        {
          sessionId: 'provider-session-1',
          update: { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' }
        },
        2
      )
    )
    expect(delivered).not.toHaveBeenCalled()
    deferred.bind({
      journal: rig.journal,
      fence: 1,
      publish: () => {
        parentPublished = true
      }
    })
    expect(await deferred.drained()).toEqual({ ok: true })
    expect(delivered).toHaveBeenCalledTimes(2)
    deferred.close()
  })
  it('holds working and finished snapshots in order across backpressure and publishes each once', async () => {
    const { rig, lane, refused, delivery } = await fixture()
    refused.value = true
    lane.apply([roster('working'), roster('completed')])
    await rig.rows()
    expect(delivery).toEqual([])
    refused.value = false
    lane.retry()
    await rig.rows()
    expect(delivery.map((batch) => batch.map((edge) => edge.type))).toEqual([['live'], ['ended']])
    expect(delivery[0][0]).toMatchObject({ child: { kind: 'agent', description: 'Exact label' } })
    expect(delivery[1][0]).toMatchObject({ outcome: 'succeeded' })
    lane.retry()
    await rig.rows()
    expect(delivery).toHaveLength(2)
  })

  it('publishes no roster facts for fatal refusal, disposed held events or events dropped after session end', async () => {
    const fatal = await fixture('failed')
    fatal.refused.value = true
    fatal.lane.apply([roster('working')])
    await fatal.rig.rows()
    expect(fatal.failed).toHaveBeenCalledWith('failed')
    expect(fatal.delivery).toEqual([])
    const held = await fixture()
    held.refused.value = true
    held.lane.apply([roster('working')])
    held.lane.dispose()
    held.refused.value = false
    held.lane.retry()
    await held.rig.rows()
    expect(held.delivery.flat().map((edge) => edge.type)).toEqual(['session-ended'])
    const ended = await fixture()
    ended.lane.apply([
      { type: 'session.ended', verdict: { state: 'interrupted', completedAt: 10 } }
    ])
    await ended.rig.rows()
    ended.lane.apply([roster('working')])
    await ended.rig.rows()
    expect(ended.delivery.flat().map((edge) => edge.type)).toEqual(['session-ended'])
  })

  it('does not let a throwing optional evidence consumer poison the journal', async () => {
    const { rig, lane } = await fixture()
    const failure = vi.fn()
    const throwing = new AcpStructuredLane({
      sink: rig.sink,
      sessionId: 'session-timeline',
      providerSessionId: 'provider-session-1',
      agent: 'grok',
      agentName: 'Grok',
      generation: 'gen-2',
      dialect: GROK_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: failure,
      onChildWorkEvidence: () => {
        throw new Error('sink unavailable')
      },
      onChildWorkFailure: failure
    })
    lane.dispose()
    lanes.push(throwing)
    throwing.apply([roster('working'), roster('completed')])
    expect(await rig.rows()).toHaveLength(1)
    expect(failure).toHaveBeenCalledTimes(2)
  })

  it('releases live ownership when session-end admission is held and disposal ends observation', async () => {
    const { rig, lane, refused, delivery } = await fixture()
    lane.apply([roster('working')])
    await rig.rows()
    refused.value = true
    lane.apply([{ type: 'session.ended', verdict: { state: 'interrupted', completedAt: 20 } }])
    lane.dispose()
    await rig.rows()
    expect(delivery.flat().map((edge) => edge.type)).toEqual(['live', 'session-ended'])
    lane.apply([roster('working')])
    lane.retry()
    await rig.rows()
    expect(delivery.flat().map((edge) => edge.type)).toEqual(['live', 'session-ended'])
  })
})
