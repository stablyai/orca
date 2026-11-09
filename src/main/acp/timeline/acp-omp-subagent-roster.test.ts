import { readFile } from 'node:fs/promises'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { describe, expect, it } from 'vitest'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'
import { foldAgentLeadStatus } from '../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import { agentChildWorkLiveness } from '../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const SESSION = 'session-1'

function roster(seq: number, children: unknown[]) {
  return { sessionId: SESSION, seq, children }
}

function newTranslator() {
  return new AcpTimelineTranslator({ sessionId: SESSION, dialect: OMP_ACP_DIALECT })
}

function send(translator: AcpTimelineTranslator, params: unknown) {
  return translator.notification('_omp/subagents', params, 10)
}

type ProducerFrame = {
  sessionId: string
  parentToolCallId: string | null
  seq: number
  children: unknown[]
}

async function producerFixture(): Promise<ProducerFrame[]> {
  const text = await readFile(
    new URL('../fixtures/omp-subagents-roster.jsonl', import.meta.url),
    'utf8'
  )
  const frames: ProducerFrame[] = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  return frames
}

describe('OMP _omp/subagents roster', () => {
  it('consumes producer fixture: children go live then end once with their terminal outcome', async () => {
    const translator = new AcpTimelineTranslator({
      sessionId: 'session-a',
      dialect: OMP_ACP_DIALECT
    })
    for (const params of await producerFixture()) {
      expect(params.sessionId).toBe('session-a')
      send(translator, params)
    }
    const evidence = translator.subagents.drainEvidence()
    const ended = evidence.flatMap((e) => (e.type === 'ended' ? [[e.handle.id, e.outcome]] : []))
    expect(ended).toEqual([
      ['1-B', 'succeeded'],
      ['0-A', 'failed']
    ])
    expect(evidence.filter((e) => e.type === 'live').length).toBeGreaterThanOrEqual(2)
  })

  it('does not re-settle a terminal child omitted from later producer snapshots', async () => {
    const translator = new AcpTimelineTranslator({
      sessionId: 'session-a',
      dialect: OMP_ACP_DIALECT
    })
    const frames = await producerFixture()
    // Frame 3 completes 1-B; frame 4 drops it. Omission must not produce a second ended.
    for (const params of frames.slice(0, 3)) {
      send(translator, params)
    }
    const endedOf1B = (events: AgentChildWorkEvidence[]) =>
      events.filter((e) => e.type === 'ended' && e.handle.id === '1-B')
    expect(endedOf1B(translator.subagents.drainEvidence())).toHaveLength(1)
    send(translator, frames[3])
    expect(endedOf1B(translator.subagents.drainEvidence())).toEqual([])
  })

  // Real stream captured by the 2026-11-09 OMP live probe: running before end_turn, completed after it.
  async function liveProbeFrames(): Promise<ProducerFrame[]> {
    const text = await readFile(
      new URL('../fixtures/omp-subagents-live.jsonl', import.meta.url),
      'utf8'
    )
    const frames: ProducerFrame[] = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    return frames
  }

  describe('OMP live probe: idle parent with late child completion', () => {
    it('stays working until the late completed frame, then goes idle', async () => {
      const [running, completed] = await liveProbeFrames()
      const translator = new AcpTimelineTranslator({
        sessionId: running.sessionId,
        dialect: OMP_ACP_DIALECT
      })
      send(translator, running)
      const live = translator.subagents.drainEvidence()
      expect(live).toMatchObject([{ type: 'live', child: { handle: { id: 'PkgNameReader' } } }])
      // Parent turn has ended (idle lead); the live child alone keeps the row RUNNING.
      expect(
        foldAgentLeadStatus({
          leadState: 'done',
          childWorkLiveness: agentChildWorkLiveness([{ kind: 'agent', state: 'working' }])
        })
      ).toEqual({ stateName: 'working' })
      send(translator, completed)
      const ended = translator.subagents.drainEvidence()
      expect(ended).toMatchObject([
        { type: 'ended', handle: { id: 'PkgNameReader' }, outcome: 'succeeded' }
      ])
      expect(
        foldAgentLeadStatus({
          leadState: 'done',
          childWorkLiveness: agentChildWorkLiveness([{ kind: 'agent', state: 'done' }])
        })
      ).toEqual({ stateName: 'done' })
    })
  })
  it('advertises the roster capability and maps snapshot states', () => {
    expect(OMP_ACP_DIALECT.clientCapabilities?._meta).toEqual({ 'omp/subagents': true })
    const translator = newTranslator()
    send(
      translator,
      roster(1, [
        {
          id: 'a',
          agent: 'task',
          description: 'Explore',
          status: 'running',
          async: true,
          updatedAt: 1
        },
        {
          id: 'b',
          agent: 'task',
          description: null,
          status: 'completed',
          async: false,
          updatedAt: 2
        },
        {
          id: 'c',
          agent: 'task',
          description: ' Fail ',
          status: 'failed',
          async: false,
          updatedAt: 3
        }
      ])
    )
    expect(translator.subagents.drainEvidence().map((e) => e.type)).toEqual([
      'live',
      'ended',
      'ended'
    ])
  })

  it('ignores a malformed envelope and drops only malformed children', () => {
    const translator = newTranslator()
    expect(send(translator, { sessionId: SESSION, seq: 'x', children: [] })).toEqual([])
    send(
      translator,
      roster(1, [
        null,
        { id: '', status: 'running' },
        { id: 'ok', status: 'running' },
        { id: 'bad', status: 'constructor' },
        { id: 'proto', status: '__proto__' }
      ])
    )
    const evidence = translator.subagents.drainEvidence()
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ type: 'live', child: { handle: { id: 'ok' } } })
  })

  it('ignores out-of-order and duplicate seq snapshots', () => {
    const translator = newTranslator()
    send(translator, roster(5, [{ id: 'a', status: 'running' }]))
    translator.subagents.drainEvidence()
    send(translator, roster(5, [{ id: 'a', status: 'completed' }]))
    send(translator, roster(3, [{ id: 'a', status: 'completed' }]))
    expect(translator.subagents.drainEvidence()).toEqual([])
  })

  it('keeps a live child working; an all-settled snapshot ends it once', () => {
    const translator = newTranslator()
    send(translator, roster(1, [{ id: 'a', status: 'running' }]))
    expect(translator.subagents.drainEvidence()).toMatchObject([{ type: 'live' }])
    send(translator, roster(2, [{ id: 'a', status: 'completed' }]))
    expect(translator.subagents.drainEvidence()).toMatchObject([
      { type: 'ended', outcome: 'succeeded' }
    ])
    send(translator, roster(3, [{ id: 'a', status: 'completed' }]))
    expect(translator.subagents.drainEvidence()).toEqual([])
  })
  it('settles children omitted from a newer full snapshot', () => {
    const translator = newTranslator()
    send(translator, roster(1, [{ id: 'a', status: 'running' }]))
    translator.subagents.drainEvidence()
    send(translator, roster(2, []))
    expect(translator.subagents.drainEvidence()).toMatchObject([
      { type: 'ended', outcome: 'cancelled' }
    ])
  })

  it('a foreign-session roster reusing a known child id cannot settle or advance owned roster', () => {
    const translator = newTranslator()
    send(translator, roster(1, [{ id: 'a', status: 'running' }]))
    expect(translator.subagents.drainEvidence()).toMatchObject([{ type: 'live' }])
    // Session B reuses child id 'a' with a higher seq; applying it would settle A and block A's seq 2.
    expect(
      translator.notification(
        '_omp/subagents',
        {
          sessionId: 'session-other',
          seq: 9,
          parentToolCallId: null,
          children: [{ id: 'a', status: 'completed' }]
        },
        20
      )
    ).toEqual([])
    expect(translator.subagents.drainEvidence()).toEqual([])
    send(translator, roster(2, [{ id: 'a', status: 'completed' }]))
    expect(translator.subagents.drainEvidence()).toMatchObject([
      { type: 'ended', outcome: 'succeeded' }
    ])
  })

  it('marks the roster as authoritative so task progress is not used as fallback', () => {
    const translator = newTranslator()
    expect(translator.subagents.hasRoster()).toBe(false)
    send(translator, roster(1, [{ id: 'a', status: 'running' }]))
    expect(translator.subagents.hasRoster()).toBe(true)
  })

  it('ignores a roster for another ACP session', () => {
    const translator = newTranslator()
    expect(
      translator.notification(
        '_omp/subagents',
        { ...roster(1, [{ id: 'foreign', status: 'running' }]), sessionId: 'session-other' },
        10
      )
    ).toEqual([])
    expect(translator.subagents.drainEvidence()).toEqual([])
    expect(translator.subagents.hasRoster()).toBe(false)
  })

  it('clears live children on ACP disconnect disposal', () => {
    const translator = newTranslator()
    send(translator, roster(1, [{ id: 'a', status: 'running' }]))
    expect(translator.subagents.drainEvidence()).toMatchObject([{ type: 'live' }])
    translator.dispose()
    expect(translator.subagents.drainEvidence()).toEqual([])
  })

  it('folds an idle lead to working while a child is live, then done when settled', () => {
    const live = agentChildWorkLiveness([{ kind: 'agent', state: 'working' }])
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: live })).toEqual({
      stateName: 'working'
    })
    expect(
      foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: agentChildWorkLiveness([]) })
    ).toEqual({ stateName: 'done' })
  })
})
