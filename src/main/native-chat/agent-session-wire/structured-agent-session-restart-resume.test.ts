import { availableParallelism } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionResumableSet } from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission,
  STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY,
  STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS
} from './structured-agent-session-restart-resume-runner'
import { structuredAgentSessionWorkingAtStop } from './structured-agent-session-working-at-teardown'
import {
  childRecord,
  CLAUDE_ROOT,
  claudeRecord,
  EPOCH,
  HANDLE_ROOT,
  journal,
  TEARDOWN_CURRENT,
  marker,
  NOW,
  pendingApproval,
  record,
  resumableSet,
  SESSION,
  submission,
  turnItem
} from './structured-agent-session-restart-resume-test-harness'

type StopInput = Parameters<typeof structuredAgentSessionWorkingAtStop>[0]

function markersAtTeardown(
  input: Omit<StopInput, 'sessionId' | 'session'> & {
    sessions: ReadonlyMap<string, NonNullable<StopInput['session']>>
  }
) {
  return [...input.sessions].flatMap(([sessionId, session]) => {
    const recorded = structuredAgentSessionWorkingAtStop({ ...input, sessionId, session })
    return recorded ? [recorded] : []
  })
}

describe('deriving what was working at teardown', () => {
  it('marks a session this host was running a turn for', () => {
    const markers = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers).toEqual([
      {
        sessionId: SESSION,
        work: { kind: 'turn', id: 'turn-1' },
        recordedAt: NOW,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        journalCursor: { epoch: EPOCH, sequence: 1 },
        providerHandleRoot: HANDLE_ROOT,
        latestUserItemId: null,
        activity: { state: 'working', prompts: [], tasks: [] }
      }
    ])
  })

  it('carries the update trigger so the surface can say the restart was not the user choice', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'update',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.trigger).toBe('update')
  })

  it('marks nothing for an idle session', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([]), child: { fence: 1, phase: 'ready' as const } }]
        ]),
        getRecord: () => record(),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('marks nothing for a turn that completed before the quit', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-1', 'completed')]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => record(),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Persisted running rows prove no live execution; only this runtime’s child can justify a witness.
  it('marks nothing for a stale running row this host was not executing', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'running')]), child: null }]
        ]),
        getRecord: () => record(),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Capture lost prompts with the same work snapshot so blocked offers name what they lost.
  it('marks a turn that is waiting on the user, with the prompt beside the state', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running'), pendingApproval()]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'turn', id: 'turn-1' })
    expect(recorded?.activity).toEqual({
      state: 'blocked',
      prompts: [{ kind: 'approval', label: 'Run the command?' }],
      tasks: []
    })
  })

  it('marks a settled lead whose subagent was still running, anchored on its last turn', () => {
    const markers = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'completed')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => [childRecord({ id: 'task-a', kind: 'agent', description: 'Review loop 4' })],
      trigger: 'update',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers.map((entry) => entry.work)).toEqual([{ kind: 'turn', id: 'turn-1' }])
    expect(markers[0]?.activity).toEqual({
      state: 'done',
      prompts: [],
      tasks: [{ kind: 'agent', label: 'Review loop 4' }]
    })
  })

  it('records only the live rows of the roster, bounded', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'completed')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => [
        childRecord({ id: 'gone', kind: 'agent', description: 'Finished agent', state: 'done' }),
        ...Array.from({ length: 20 }, (_, index) =>
          childRecord({
            id: `live-${index}`,
            kind: 'command',
            description: `Shell ${index}${'x'.repeat(300)}`
          })
        )
      ],
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.activity?.tasks).toHaveLength(16)
    expect(recorded?.activity?.tasks.every((task) => task.kind === 'command')).toBe(true)
    expect(recorded?.activity?.tasks.every((task) => task.label.length <= 200)).toBe(true)
  })

  it('marks a settled lead whose only live work is a monitor', () => {
    const markers = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'completed')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => [
        childRecord({ id: 'task-m', kind: 'monitor', name: 'ci-watch', state: 'monitoring' })
      ],
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers).toHaveLength(1)
  })

  it('marks nothing for a settled lead whose tasks have all finished', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-1', 'completed')]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => record(),
        childWorkOpen: () => false,
        childWork: () => [
          childRecord({ id: 'task-a', kind: 'agent', state: 'done' }),
          childRecord({ id: 'task-b', kind: 'command', state: 'idle' })
        ],
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('records the identity root so an advancing Claude leaf cannot invalidate the marker', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.providerHandleRoot).toBe(CLAUDE_ROOT)
  })

  it('marks nothing for a session that never proved a provider cursor', () => {
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-1', 'running')]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => record({ chain: [] }),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Claude may echo user input long after dispatch; mark the send before any turn ID exists.
  it('records the submission identity for a send the provider has not echoed yet', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([], [submission('msg-1', 'pending')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  it('marks a send the provider had not opened a turn for, after an earlier completed turn', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-0', 'completed')], [submission('msg-1', 'pending')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  it('marks nothing for a session whose only work is a message still queued', () => {
    const queued = { ...submission('msg-1', 'pending'), handoverRecorded: true as const }
    expect(
      markersAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-0', 'completed')], [queued]),
              child: { fence: 1, phase: 'ready' as const }
            }
          ]
        ]),
        getRecord: () => claudeRecord(null),
        childWorkOpen: () => false,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('marks a handed-over message over a newer queued one, and a turn a queued one waits behind', () => {
    const handedOver = {
      ...submission('msg-1', 'pending'),
      handoverRecorded: true as const,
      handedOverAt: NOW
    }
    const queued = { ...submission('msg-2', 'pending'), handoverRecorded: true as const }
    const markers = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-0', 'completed')], [handedOver, queued]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ],
        [
          'session-running',
          {
            journal: journal([turnItem('turn-1', 'running')], [queued]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(markers.map((entry) => entry.work)).toEqual([
      { kind: 'submission', id: 'msg-1' },
      { kind: 'turn', id: 'turn-1' }
    ])
  })

  it('prefers the running turn over the send that opened it', () => {
    const [recorded] = markersAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running')], [submission('msg-1', 'accepted')]),
            child: { fence: 1, phase: 'ready' as const }
          }
        ]
      ]),
      getRecord: () => record(),
      childWorkOpen: () => false,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'turn', id: 'turn-1' })
  })
})

describe('the resumable set', () => {
  it('offers a genuinely working session exactly once', () => {
    const { candidates } = resumableSet({ markers: [marker()] })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      sessionId: SESSION,
      work: { kind: 'turn', id: 'turn-1' },
      trigger: 'quit',
      latestPrompt: 'fix the auth bug'
    })
  })

  it('offers nothing for a stale running row with no marker', () => {
    expect(
      resumableSet({ markers: [], items: [turnItem('turn-1', 'running')] }).candidates
    ).toEqual([])
  })

  it('refuses when the session has no resume cursor', () => {
    expect(resumableSet({ markers: [marker()], chain: [] }).candidates).toEqual([])
  })

  it('refuses when the resume cursor drifted after the marker was written', () => {
    expect(
      resumableSet({ markers: [marker({ providerHandleRoot: 'codex:"other-thread"' })] }).candidates
    ).toEqual([])
  })

  // Same-teardown close advances Claude’s leaf; comparing full keys would permanently reject continuity.
  it('still offers a Claude session whose leaf advanced after the marker was written', () => {
    const { candidates } = structuredAgentSessionResumableSet({
      markers: [marker({ providerHandleRoot: CLAUDE_ROOT })],
      getRecord: () => claudeRecord('5aed93d6-advanced-leaf'),
      supportsRecord: () => true,
      latestPrompt: () => '',
      movedOn: () => false,
      savedByNewerOrca: () => false
    })

    expect(candidates).toHaveLength(1)
  })

  it('withdraws and reports for deletion a Claude session that forked to a different root', () => {
    const forked = marker({ providerHandleRoot: CLAUDE_ROOT })
    const set = structuredAgentSessionResumableSet({
      markers: [forked],
      getRecord: () => claudeRecord(null, 'prov-session-2'),
      supportsRecord: () => true,
      latestPrompt: () => '',
      movedOn: () => false,
      savedByNewerOrca: () => false
    })

    expect(set.candidates).toEqual([])
    expect(set.superseded).toEqual([forked])
  })

  it("neither offers nor spends a newer Orca's chat, and offers it once this build can open it", () => {
    const offer = marker()
    expect(resumableSet({ markers: [offer], savedByNewerOrca: [SESSION] })).toEqual({
      candidates: [],
      superseded: []
    })
    expect(resumableSet({ markers: [offer] }).candidates).toHaveLength(1)
  })

  it('still withdraws a forked chat a newer Orca saved', () => {
    const forked = marker({ providerHandleRoot: 'codex:"other-thread"' })
    expect(resumableSet({ markers: [forked], savedByNewerOrca: [SESSION] }).superseded).toEqual([
      forked
    ])
  })

  it('still offers a months-old marker', () => {
    const monthsAgo = NOW - 90 * 24 * 60 * 60 * 1000
    expect(resumableSet({ markers: [marker({ recordedAt: monthsAgo })] }).candidates).toHaveLength(
      1
    )
  })

  // Structural refusal must preserve a durable offer the user still owns.
  it('does not report a structurally refused marker for deletion', () => {
    expect(resumableSet({ markers: [marker()], chain: [] }).superseded).toEqual([])
  })

  // Provider-authored restore rows cannot overturn teardown’s observed work.
  it.each([
    ['its turn completed', [turnItem('turn-1', 'completed')]],
    [
      'a provider turn is running',
      [turnItem('turn-1', 'interrupted'), turnItem('wake', 'running')]
    ],
    ['the provider asks the user', [turnItem('turn-1', 'interrupted'), pendingApproval()]],
    ['the journal holds no turn', []]
  ])('still offers the marked chat when %s', (_label, items) => {
    expect(resumableSet({ markers: [marker()], items }).candidates).toHaveLength(1)
  })

  it('offers a send that never became a turn', () => {
    const { candidates } = resumableSet({
      markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
      items: []
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  it('carries the marker snapshot as the offer activity, untouched by the journal', () => {
    const activity = {
      state: 'done' as const,
      prompts: [],
      tasks: [{ kind: 'agent' as const, label: 'Review loop 4' }]
    }
    const { candidates } = resumableSet({
      markers: [marker({ activity })],
      items: [turnItem('turn-1', 'completed'), turnItem('wake', 'running')]
    })

    expect(candidates[0]?.activity).toEqual(activity)
  })

  it('offers a marker with no snapshot, with no activity to name', () => {
    const [candidate] = resumableSet({ markers: [marker()] }).candidates

    expect(candidate).toBeDefined()
    expect(candidate).not.toHaveProperty('activity')
  })
})

describe('spending a marker', () => {
  function runner(
    overrides: {
      resume?: () => Promise<void>
      admission?: StructuredAgentSessionResumeAdmission
    } = {}
  ) {
    const consumed = new Set<string>()
    const resume = overrides.resume ?? vi.fn(async () => {})
    return {
      resume,
      consumed,
      deps: {
        admission: overrides.admission ?? new StructuredAgentSessionResumeAdmission(),
        consumeMarker: async (sessionId: string) => {
          if (consumed.has(sessionId)) {
            return false
          }
          consumed.add(sessionId)
          return true
        },
        resume
      }
    }
  }

  const candidate = (sessionId: string) => ({
    sessionId,
    workspaceId: 'workspace-1',
    agent: 'codex' as const,
    work: { kind: 'turn' as const, id: 'turn-1' },
    trigger: 'quit' as const,
    recordedAt: NOW,
    latestPrompt: '',
    executionHostId: 'local' as const,
    workspaceKind: 'git-worktree' as const
  })

  it('resumes a candidate once and reports it', async () => {
    const { deps, resume } = runner()

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'banner'
    )

    expect(outcomes).toEqual([{ sessionId: SESSION, outcome: 'resumed' }])
    expect(resume).toHaveBeenCalledOnce()
  })

  it('refuses a marker a previous launch already consumed', async () => {
    const { deps, resume } = runner()
    await resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'first-launch')

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'second-launch'
    )

    expect(outcomes).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'agent_session_resume_not_eligible' }
    ])
    expect(resume).toHaveBeenCalledOnce()
  })

  it('spends the marker before it submits, so a crash mid-resume cannot double-fire', async () => {
    const order: string[] = []
    const { deps, consumed } = runner({
      resume: async () => {
        order.push(`consumed:${consumed.has(SESSION)}`)
        throw new Error('provider died mid-resume')
      }
    })

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'banner'
    )

    expect(order).toEqual(['consumed:true'])
    expect(outcomes[0]).toMatchObject({ outcome: 'refused' })
    expect(consumed.has(SESSION)).toBe(true)
  })

  it('refuses a second concurrent resume and names the live owner', async () => {
    let release = (): void => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps } = runner({ resume: () => blocked })

    const first = resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'banner')
    await vi.waitFor(() => expect(deps.admission.liveOwner(SESSION)).toBe('banner'))
    const second = await resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'row')
    release()
    await first

    expect(second).toEqual([
      {
        sessionId: SESSION,
        outcome: 'refused',
        reason: STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS,
        owner: 'banner'
      }
    ])
  })

  it('staggers instead of starting every provider at once', async () => {
    let live = 0
    let peak = 0
    const { deps } = runner({
      admission: new StructuredAgentSessionResumeAdmission(3),
      resume: async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((resolve) => setTimeout(resolve, 5))
        live -= 1
      }
    })
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate(`session-staggered-${index}`)
    )

    const outcomes = await resumeStructuredAgentSessionsFromRestart(deps, candidates, 'banner')

    expect(peak).toBe(3)
    expect(outcomes).toHaveLength(candidates.length)
  })

  it('shares the start limit across separate resume requests', async () => {
    let live = 0
    let peak = 0
    const { deps } = runner({
      admission: new StructuredAgentSessionResumeAdmission(3),
      resume: async () => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((resolve) => setTimeout(resolve, 5))
        live -= 1
      }
    })

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        resumeStructuredAgentSessionsFromRestart(
          deps,
          [candidate(`session-separate-${index}`)],
          'modal'
        )
      )
    )

    expect(peak).toBe(3)
    expect(outcomes.flat().every((outcome) => outcome.outcome === 'resumed')).toBe(true)
  })

  it('sizes the default start limit to this machine', () => {
    expect(STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY).toBe(Math.max(1, availableParallelism()))
  })
})
