import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { createClaudeJournalTranslator } from '../structured/journal/claude-structured-journal-translation'

const bashCall = {
  type: 'assistant',
  uuid: 'a1',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'make test' } }]
  }
}
const bashStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'bash-1',
  tool_use_id: 'toolu_1',
  description: 'make test',
  task_type: 'local_bash',
  is_backgrounded: false,
  session_id: 'session-1'
}
const movedToBackground = {
  type: 'system',
  subtype: 'task_updated',
  task_id: 'bash-1',
  patch: { is_backgrounded: true },
  session_id: 'session-1'
}

const turnResult = { type: 'result', subtype: 'success', session_id: 'session-1' }

const answered = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid: `answer-${id}`,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  ...extra
})

function edges(frames: Record<string, unknown>[], ownerOf?: (toolUseId: string) => string | null) {
  const journal = createClaudeJournalTranslator({
    sink: { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
  })
  const decoder = new ClaudeChildWorkDecoder(journal.taskInvocations)
  return frames.flatMap((message) => {
    decoder.observe(message, ownerOf)
    journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
    return decoder.drain(1_000)
  })
}

function residencies(frames: Record<string, unknown>[]) {
  const journal = createClaudeJournalTranslator({
    sink: { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
  })
  const decoder = new ClaudeChildWorkDecoder(journal.taskInvocations)
  return frames.flatMap((message) => {
    decoder.observe(message)
    journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
    return decoder
      .drain(1_000)
      .flatMap((edge) =>
        edge.type === 'live' ? [{ kind: edge.child.kind, residency: edge.child.residency }] : []
      )
  })
}

describe('Claude shell command residency', () => {
  it('reports an ordinary Bash call as a foreground command', () => {
    expect(residencies([bashCall, bashStarted])).toEqual([
      { kind: 'command', residency: 'foreground' }
    ])
  })

  it('reports the same command as background once Claude moves it there', () => {
    expect(residencies([bashCall, bashStarted, movedToBackground]).at(-1)).toEqual({
      kind: 'command',
      residency: 'background'
    })
  })

  it('keeps a command Claude moved to the background running past the turn', () => {
    expect(
      edges([bashCall, bashStarted, movedToBackground, turnResult]).filter(
        (edge) => edge.type === 'ended'
      )
    ).toEqual([])
  })

  it('reports a command as background once Claude lists it in its background roster', () => {
    const roster = {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'bash-1', tool_use_id: 'toolu_1', task_type: 'local_bash', status: 'running' }
      ],
      session_id: 'session-1'
    }
    expect(residencies([bashCall, bashStarted, roster]).at(-1)).toEqual({
      kind: 'command',
      residency: 'background'
    })
    expect(
      edges([bashCall, bashStarted, roster, turnResult]).filter((edge) => edge.type === 'ended')
    ).toEqual([])
  })
})

// Frames Claude Code 2.1.332 emitted over stream-json (ids kept, output paths dropped).
describe('captured Claude command frames', () => {
  const call = (id: string) => ({
    type: 'assistant',
    uuid: `call-${id}`,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] }
  })
  const result = (id: string, content: string) => ({
    type: 'user',
    uuid: `result-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }
  })

  it('a short foreground command starts and ends inside its tool call', () => {
    const tool = 'toolu_01QSk1BmJTGmvrskEAXkQaxg'
    const frames = edges([
      call(tool),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'b0kpvgw21',
        run_id: '0mwycnsdc-1b0c2171',
        tool_use_id: tool,
        description: 'Run a 3-second sleep then print finished',
        is_backgrounded: false,
        task_type: 'local_bash'
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'b0kpvgw21',
        run_id: '0mwycnsdc-1b0c2171',
        tool_use_id: tool,
        status: 'completed',
        output_file: '',
        summary: 'Run a 3-second sleep then print finished'
      },
      result(tool, 'finished'),
      turnResult
    ])
    expect(frames.map((edge) => edge.type)).toEqual(['live', 'ended'])
    expect(frames[0]).toMatchObject({ child: { residency: 'foreground' } })
    expect(frames[1]).toMatchObject({ outcome: 'succeeded' })
  })

  it('a command that outruns its timeout moves to the background before its tool call returns', () => {
    const tool = 'toolu_01DTp3R9nkkmC55eJ5UqzRj4'
    const run = '0mwycl6ur-dd13ddb3'
    const description = 'Sleep 45 seconds then print finished'
    const frames = edges([
      call(tool),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'b7do1935w',
        run_id: run,
        tool_use_id: tool,
        description,
        is_backgrounded: false,
        task_type: 'local_bash'
      },
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'b7do1935w', run_id: run, task_type: 'local_bash', description }]
      },
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'b7do1935w',
        run_id: run,
        patch: { is_backgrounded: true }
      },
      result(
        tool,
        'Command did not complete within its 5s timeout and was moved to the background'
      ),
      turnResult,
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'b7do1935w',
        run_id: run,
        patch: { status: 'completed', end_time: 1795745681214 }
      },
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'b7do1935w',
        run_id: run,
        tool_use_id: tool,
        status: 'completed',
        summary: `Background command "${description}" completed (exit code 0)`
      },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
    ])
    const live = frames.flatMap((edge) => (edge.type === 'live' ? [edge.child] : []))
    expect(live[0]).toMatchObject({ residency: 'foreground' })
    // The roster alone already moves it, before the patch says so.
    expect(live[1]).toMatchObject({ residency: 'background', state: 'working', stoppable: true })
    expect(live.every((child) => child.state !== 'unverifiable')).toBe(true)
    // The completed patch and the notification each end it; admission keeps the first.
    const ended = frames.filter((edge) => edge.type === 'ended')
    expect(ended.length).toBeGreaterThan(0)
    expect(ended.every((edge) => edge.type === 'ended' && edge.outcome === 'succeeded')).toBe(true)
  })
})

describe('a foreground command that outlives its own call', () => {
  const lastLive = (frames: ReturnType<typeof edges>) =>
    frames.flatMap((edge) => (edge.type === 'live' ? [edge.child] : [])).at(-1)
  const lostEnd = [bashCall, bashStarted, answered('toolu_1'), turnResult]

  it('is surfaced as unverified background work once its answered turn ends', () => {
    const frames = edges(lostEnd)
    expect(frames.filter((edge) => edge.type === 'ended')).toEqual([])
    expect(lastLive(frames)).toMatchObject({
      kind: 'command',
      residency: 'background',
      state: 'unverifiable',
      stoppable: true
    })
  })

  it('is never surfaced by a result while its own call is still running', () => {
    // A stray, late or replayed result cannot reach a command whose tool call has no result yet.
    expect(lastLive(edges([bashCall, bashStarted, turnResult]))).toMatchObject({
      residency: 'foreground',
      state: 'working'
    })
  })

  it.each([
    ['a running patch', { subtype: 'task_updated', patch: { status: 'running' } }],
    ['a renamed patch', { subtype: 'task_updated', patch: { description: 'make test again' } }],
    ['a progress frame', { subtype: 'task_progress', description: 'still going' }],
    [
      'the background roster',
      {
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bash-1', task_type: 'local_bash' }]
      }
    ]
  ])('stops being unverified on a usable later frame: %s', (_name, frame) => {
    const later = { type: 'system', task_id: 'bash-1', session_id: 'session-1', ...frame }
    expect(lastLive(edges([...lostEnd, later]))).toMatchObject({
      residency: 'background',
      state: 'working'
    })
  })

  it('stays unverified on a frame that carries nothing usable (acknowledged limit)', () => {
    // Recovery then is its terminal frame, an accepted Stop, or the session ending.
    const endTimeOnly = {
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bash-1',
      patch: { end_time: 1 },
      session_id: 'session-1'
    }
    expect(lastLive(edges([...lostEnd, endTimeOnly]))).toMatchObject({ state: 'unverifiable' })
  })

  it('keeps its returned call through a repeated start of the same run', () => {
    expect(
      lastLive(edges([bashCall, bashStarted, answered('toolu_1'), bashStarted, turnResult]))
    ).toMatchObject({
      residency: 'background',
      state: 'unverifiable'
    })
  })

  it('forgets the returned call when the task starts a new run', () => {
    const nextCall = {
      ...bashCall,
      uuid: 'a2',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }]
      }
    }
    const nextStart = { ...bashStarted, tool_use_id: 'toolu_2' }
    const end = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bash-1',
      tool_use_id: 'toolu_1',
      status: 'completed',
      session_id: 'session-1'
    }
    expect(
      lastLive(
        edges([bashCall, bashStarted, answered('toolu_1'), end, nextCall, nextStart, turnResult])
      )
    ).toMatchObject({ residency: 'foreground', state: 'working' })
  })

  it('ends on its own terminal frame', () => {
    const end = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bash-1',
      status: 'completed',
      session_id: 'session-1'
    }
    expect(edges([...lostEnd, end]).at(-1)).toMatchObject({ type: 'ended', outcome: 'succeeded' })
  })

  describe('owned by a subagent', () => {
    const agentCall = {
      type: 'assistant',
      uuid: 'a0',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: {} }]
      }
    }
    const agentStarted = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-1',
      tool_use_id: 'toolu_agent',
      description: 'Explore',
      task_type: 'local_agent',
      is_backgrounded: true,
      session_id: 'session-1'
    }
    const agentEnded = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'agent-1',
      status: 'completed',
      session_id: 'session-1'
    }
    const owned = { ...bashStarted, task_id: 'bash-owned', tool_use_id: 'toolu_owned' }
    const ownedAnswer = answered('toolu_owned', { parent_tool_use_id: 'toolu_agent' })

    it('is surfaced when its subagent ends even if its own call never returned', () => {
      const frames = edges([
        agentCall,
        agentStarted,
        { ...owned, parent_task_id: 'agent-1' },
        agentEnded
      ])
      expect(lastLive(frames)).toMatchObject({
        handle: { id: 'bash-owned' },
        residency: 'background',
        state: 'unverifiable'
      })
    })

    const ownedById = { ...owned, parent_task_id: 'agent-1' }
    const ownedState = (frames: ReturnType<typeof edges>) =>
      frames
        .flatMap((edge) =>
          edge.type === 'live' && edge.child.handle.id === 'bash-owned' ? [edge.child] : []
        )
        .at(-1)

    it('is surfaced when its subagent is stopped', () => {
      const stopped = { ...agentEnded, status: 'stopped' }
      expect(ownedState(edges([agentCall, agentStarted, ownedById, stopped]))).toMatchObject({
        residency: 'background',
        state: 'unverifiable'
      })
    })

    it('waits for a background subagent’s notification, not its earlier terminal patch', () => {
      const terminalPatch = {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'agent-1',
        patch: { status: 'completed' },
        session_id: 'session-1'
      }
      expect(ownedState(edges([agentCall, agentStarted, ownedById, terminalPatch]))).toMatchObject({
        residency: 'foreground',
        state: 'working'
      })
      expect(
        ownedState(edges([agentCall, agentStarted, ownedById, terminalPatch, agentEnded]))
      ).toMatchObject({ residency: 'background', state: 'unverifiable' })
    })

    it('never treats a task as its own owner', () => {
      const selfOwned = { ...owned, parent_task_id: 'bash-owned' }
      expect(
        ownedState(edges([agentCall, agentStarted, selfOwned, ownedAnswer, turnResult]))
      ).toMatchObject({ residency: 'background', state: 'unverifiable' })
    })

    it.each([
      ['parent_task_id', { ...owned, parent_task_id: 'agent-1' }, undefined],
      // Announced without parent_task_id: the journal attributes its call to the subagent.
      [
        'the journal',
        owned,
        (toolUseId: string) => (toolUseId === 'toolu_owned' ? 'agent-1' : null)
      ]
    ])(
      'through %s: the lead’s turn end leaves it, its subagent’s end surfaces it',
      (_name, started, ownerOf) => {
        const beforeOwnerEnds = edges(
          [agentCall, agentStarted, started, ownedAnswer, turnResult],
          ownerOf
        )
        expect(
          beforeOwnerEnds.flatMap((edge) =>
            edge.type === 'live' && edge.child.handle.id === 'bash-owned' ? [edge.child.state] : []
          )
        ).not.toContain('unverifiable')
        const frames = edges(
          [agentCall, agentStarted, started, ownedAnswer, turnResult, agentEnded],
          ownerOf
        )
        expect(lastLive(frames)).toMatchObject({
          handle: { id: 'bash-owned' },
          residency: 'background',
          state: 'unverifiable'
        })
      }
    )
  })
})

describe('the returned-call mark', () => {
  function decoderAfter(frames: Record<string, unknown>[]) {
    const journal = createClaudeJournalTranslator({
      sink: { appendItem: () => {}, appendTombstone: () => {}, publish: () => {} }
    })
    const decoder = new ClaudeChildWorkDecoder(journal.taskInvocations)
    for (const message of frames) {
      decoder.observe(message)
      journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
      decoder.drain(1_000)
    }
    return decoder
  }

  it.each([
    [
      'a roster refresh without a tool id',
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'bash-1', task_type: 'local_bash' }]
      }
    ],
    [
      'a progress frame',
      { type: 'system', subtype: 'task_progress', task_id: 'bash-1', description: 'still going' }
    ]
  ])('survives %s of the same run', (_name, frame) => {
    const decoder = decoderAfter([bashCall, bashStarted, answered('toolu_1'), frame])
    expect(decoder.live.get('bash-1')).toMatchObject({ answered: true })
  })
})
