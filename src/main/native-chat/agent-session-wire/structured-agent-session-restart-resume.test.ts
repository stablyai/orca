// The restart-resume safety rules, stated as refusals.
//
// Every negative case here is a session that MUST NOT get a provider child back. Resuming one that
// was not working spends the user's tokens and can make an agent redo destructive work it already
// finished; missing one is an annoyance. Each test removes exactly one input from an otherwise
// resumable session, so deleting the matching guard turns that test red.

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_RESUME_MARKER_TTL_MS,
  type AgentSessionResumeMarker
} from '../../../shared/agent-session-resume-marker'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'
import { newestStructuredAgentSessionTurn } from '../../../shared/structured-agent-session-live-turn'
import { structuredAgentSessionResumableSet } from './structured-agent-session-restart-resume-set'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission,
  STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY,
  STRUCTURED_AGENT_SESSION_RESUME_IN_PROGRESS
} from './structured-agent-session-restart-resume-runner'
import { structuredAgentSessionsWorkingAtTeardown } from './structured-agent-session-working-at-teardown'
import {
  CLAUDE_ROOT,
  claudeRecord,
  HANDLE_ROOT,
  journal,
  TEARDOWN_CURRENT,
  marker,
  NOW,
  pendingApproval,
  record,
  SESSION,
  submission,
  turnItem
} from './structured-agent-session-restart-resume-test-harness'

function resumableSet(input: {
  markers: AgentSessionResumeMarker[]
  items?: AgentJournalRenderItem[]
  submissions?: AgentJournalSubmission[]
  chain?: AgentSessionRecord['providerHandleChain']
  now?: number
}) {
  const items = input.items ?? [turnItem('turn-1', 'interrupted')]
  const submissions = input.submissions ?? []
  return structuredAgentSessionResumableSet({
    markers: input.markers,
    getRecord: () => record(input.chain === undefined ? {} : { chain: input.chain }),
    supportsRecord: () => true,
    waitingOnUser: () => projectStructuredAgentSessionStatus(items) === 'attention',
    journalTurn: () => newestStructuredAgentSessionTurn(items),
    journalSubmission: (_sessionId, clientMessageId) =>
      submissions.find((entry) => entry.clientMessageId === clientMessageId) ?? null,
    latestPrompt: () => 'fix the auth bug',
    latestUserItemId: () => null,
    now: input.now ?? NOW
  })
}

describe('deriving what was working at teardown', () => {
  it('marks a session this host was running a turn for', () => {
    const markers = structuredAgentSessionsWorkingAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
      ]),
      getRecord: () => record(),
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
        providerHandleRoot: HANDLE_ROOT,
        latestUserItemId: null
      }
    ])
  })

  it('carries the update trigger so the surface can say the restart was not the user choice', () => {
    const [recorded] = structuredAgentSessionsWorkingAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
      ]),
      getRecord: () => record(),
      trigger: 'update',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.trigger).toBe('update')
  })

  it('marks nothing for an idle session', () => {
    expect(
      structuredAgentSessionsWorkingAtTeardown({
        sessions: new Map([[SESSION, { journal: journal([]), hasProviderChild: true }]]),
        getRecord: () => record(),
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  it('marks nothing for a turn that completed before the quit', () => {
    expect(
      structuredAgentSessionsWorkingAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'completed')]), hasProviderChild: true }]
        ]),
        getRecord: () => record(),
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // The user's stated fear. A journal restored for READING carries whatever `running` row an older
  // crash left behind, and it is the live `hasProviderChild` — not that row — that decides.
  it('marks nothing for a stale running row this host was not executing', () => {
    expect(
      structuredAgentSessionsWorkingAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: false }]
        ]),
        getRecord: () => record(),
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // The product calls this state `attention`, not `working`. A chat blocked on the user is not
  // interrupted work, and handing it a provider child resumes nothing it was actually doing.
  it('marks nothing for a turn that is waiting on the user', () => {
    expect(
      structuredAgentSessionsWorkingAtTeardown({
        sessions: new Map([
          [
            SESSION,
            {
              journal: journal([turnItem('turn-1', 'running'), pendingApproval()]),
              hasProviderChild: true
            }
          ]
        ]),
        getRecord: () => record(),
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Root, not key: a key would embed Claude's leaf, which the close path advances moments later.
  it('records the identity root so an advancing Claude leaf cannot invalidate the marker', () => {
    const [recorded] = structuredAgentSessionsWorkingAtTeardown({
      sessions: new Map([
        [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
      ]),
      getRecord: () => claudeRecord(null),
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.providerHandleRoot).toBe(CLAUDE_ROOT)
  })

  it('marks nothing for a session that never proved a provider cursor', () => {
    expect(
      structuredAgentSessionsWorkingAtTeardown({
        sessions: new Map([
          [SESSION, { journal: journal([turnItem('turn-1', 'running')]), hasProviderChild: true }]
        ]),
        getRecord: () => record({ chain: [] }),
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toEqual([])
  })

  // Codex declares a turn in about 150ms; Claude cannot write one until the SDK echoes the user
  // message back, which is seconds on a real journal. A turn-id-only marker drops exactly those
  // sessions — the ones that were working hardest — so the send carries its own identity.
  it('records the submission identity for a send the provider has not echoed yet', () => {
    const [recorded] = structuredAgentSessionsWorkingAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([], false, [submission('msg-1', 'pending')]),
            hasProviderChild: true
          }
        ]
      ]),
      getRecord: () => claudeRecord(null),
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  // Once a turn exists it is the better identity: it is what eviction rewrites, so it is what the
  // journal can be asked about at launch.
  it('prefers the running turn over the send that opened it', () => {
    const [recorded] = structuredAgentSessionsWorkingAtTeardown({
      sessions: new Map([
        [
          SESSION,
          {
            journal: journal([turnItem('turn-1', 'running')], false, [
              submission('msg-1', 'accepted')
            ]),
            hasProviderChild: true
          }
        ]
      ]),
      getRecord: () => record(),
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })

    expect(recorded?.work).toEqual({ kind: 'turn', id: 'turn-1' })
  })
})

describe('the resumable set', () => {
  it('offers a genuinely working session exactly once', () => {
    const candidates = resumableSet({ markers: [marker()] })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      sessionId: SESSION,
      work: { kind: 'turn', id: 'turn-1' },
      trigger: 'quit',
      latestPrompt: 'fix the auth bug'
    })
  })

  // No marker means no teardown ever observed this session working, whatever its journal says.
  it('offers nothing for a stale running row with no marker', () => {
    expect(resumableSet({ markers: [], items: [turnItem('turn-1', 'running')] })).toEqual([])
  })

  it('refuses when the marker and the journal name different turns', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'turn', id: 'turn-9' } })],
        items: [turnItem('turn-1', 'interrupted')]
      })
    ).toEqual([])
  })

  it('refuses when the journal cannot answer for any turn', () => {
    expect(resumableSet({ markers: [marker()], items: [] })).toEqual([])
  })

  it('refuses when the session has no resume cursor', () => {
    expect(resumableSet({ markers: [marker()], chain: [] })).toEqual([])
  })

  // A cursor that moved since teardown is a different conversation than the one we marked.
  it('refuses when the resume cursor drifted after the marker was written', () => {
    expect(
      resumableSet({ markers: [marker({ providerHandleRoot: 'codex:"other-thread"' })] })
    ).toEqual([])
  })

  // The defect QA found: the SAME teardown's close path appends a `resumed` link with an advanced
  // leaf, so a key comparison goes stale ~1.4s after the marker is written and Claude is refused
  // forever. A resume that advances the leaf is continuity, not a fork.
  it('still offers a Claude session whose leaf advanced after the marker was written', () => {
    const candidates = structuredAgentSessionResumableSet({
      markers: [marker({ providerHandleRoot: CLAUDE_ROOT })],
      getRecord: () => claudeRecord('5aed93d6-advanced-leaf'),
      supportsRecord: () => true,
      waitingOnUser: () => false,
      journalTurn: () => ({ turnId: 'turn-1', state: 'interrupted' }),
      journalSubmission: () => null,
      latestPrompt: () => '',
      latestUserItemId: () => null,
      now: NOW
    })

    expect(candidates).toHaveLength(1)
  })

  it('refuses a Claude session that forked to a different identity root', () => {
    expect(
      structuredAgentSessionResumableSet({
        markers: [marker({ providerHandleRoot: CLAUDE_ROOT })],
        getRecord: () => claudeRecord(null, 'prov-session-2'),
        supportsRecord: () => true,
        waitingOnUser: () => false,
        journalTurn: () => ({ turnId: 'turn-1', state: 'interrupted' }),
        journalSubmission: () => null,
        latestPrompt: () => '',
        latestUserItemId: () => null,
        now: NOW
      })
    ).toEqual([])
  })

  // Eviction rewrites `running` -> `interrupted` and never -> `completed`, so the state is what
  // separates work that was cut off from work that finished.
  it('refuses a turn that completed before the quit', () => {
    expect(resumableSet({ markers: [marker()], items: [turnItem('turn-1', 'completed')] })).toEqual(
      []
    )
  })

  it('refuses a turn still marked running, which nothing ever settled', () => {
    expect(resumableSet({ markers: [marker()], items: [turnItem('turn-1', 'running')] })).toEqual(
      []
    )
  })

  it('offers a turn whose end the host could not verify', () => {
    expect(
      resumableSet({ markers: [marker()], items: [turnItem('turn-1', 'unverifiable')] })
    ).toHaveLength(1)
  })

  it('refuses a marker that has outlived its expiry', () => {
    expect(
      resumableSet({ markers: [marker()], now: NOW + AGENT_SESSION_RESUME_MARKER_TTL_MS + 1 })
    ).toEqual([])
  })

  // With no turn, an unanswered submission remains evidence of interrupted work.
  it.each(['pending', 'unknown'] as const)(
    'offers a send left %s, which nothing ever answered',
    (dispatchState) => {
      const candidates = resumableSet({
        markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
        items: [],
        submissions: [submission('msg-1', dispatchState)]
      })

      expect(candidates).toHaveLength(1)
      expect(candidates[0]?.work).toEqual({ kind: 'submission', id: 'msg-1' })
    }
  )

  // A rejected send never ran at all, so there is no interrupted work to hand back.
  it('refuses a send the provider rejected', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
        items: [],
        submissions: [submission('msg-1', 'rejected')]
      })
    ).toEqual([])
  })

  // THE REGRESSION, replaying the sequence measured inside one teardown: the send is journaled,
  // its dispatch settles to `accepted`, and the turn it opened is then cut off as `interrupted`.
  // The window in which work is submission-shaped is exactly the window in which the dispatch is
  // about to be accepted, so freezing judgement at the marker's shape refuses the very sessions
  // this was built for. An accepted send must be FOLLOWED FORWARD to the turn it became.
  it('offers a send that was accepted and whose turn was then interrupted', () => {
    const candidates = resumableSet({
      markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
      items: [turnItem('turn-1', 'interrupted', 'provider-item-1')],
      submissions: [submission('msg-1', 'accepted', 'provider-item-1')]
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.work).toEqual({ kind: 'submission', id: 'msg-1' })
  })

  it('offers a send whose turn the host could not verify', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
        items: [turnItem('turn-1', 'unverifiable', 'provider-item-1')],
        submissions: [submission('msg-1', 'accepted', 'provider-item-1')]
      })
    ).toHaveLength(1)
  })

  // Following forward must not become a way to resume finished work: the turn's own state still
  // decides, exactly as it does for a turn-shaped marker.
  it('refuses a send whose turn ran to completion', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
        items: [turnItem('turn-1', 'completed', 'provider-item-1')],
        submissions: [submission('msg-1', 'accepted', 'provider-item-1')]
      })
    ).toEqual([])
  })

  // QA's case: the LAST chat prompted before quitting. The provider accepted the send, but died
  // before writing a turn row for it, so there is nothing to link forward TO. An accepted send that
  // never became a turn cannot be finished work — finishing writes a turn row.
  it('offers an accepted send the provider never opened a turn for', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
        items: [],
        submissions: [submission('msg-1', 'accepted', 'provider-item-1')]
      })
    ).toHaveLength(1)
  })

  // The same chat when the session's newest turn belongs to an EARLIER exchange that was itself cut
  // off. Safe under both readings: if that row is really this send's under a key we did not match,
  // it was interrupted; if it is the earlier exchange's, this send opened no turn at all.
  it.each([
    ['the turn names a different user item', 'provider-item-other', 'provider-item-1'],
    ['the turn records no user item at all', undefined, 'provider-item-1'],
    ['the submission has no provider key', 'provider-item-1', null]
  ])(
    'offers an accepted send beside an interrupted turn when %s',
    (_label, userItemId, providerItemId) => {
      expect(
        resumableSet({
          markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
          items: [turnItem('turn-1', 'interrupted', userItemId)],
          submissions: [submission('msg-1', 'accepted', providerItemId)]
        })
      ).toHaveLength(1)
    }
  )

  // THE SAFETY EDGE. An unmatched `completed` row might be this very send's finished turn under a
  // key we failed to recognise, and resuming finished work is the one outcome never worth risking.
  // The two readings disagree here, so the ambiguity resolves to no.
  it.each([
    ['the turn names a different user item', 'provider-item-other', 'provider-item-1'],
    ['the turn records no user item at all', undefined, 'provider-item-1'],
    ['the submission has no provider key', 'provider-item-1', null]
  ])(
    'refuses an accepted send beside a completed turn when %s',
    (_label, userItemId, providerItemId) => {
      expect(
        resumableSet({
          markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
          items: [turnItem('turn-1', 'completed', userItemId)],
          submissions: [submission('msg-1', 'accepted', providerItemId)]
        })
      ).toEqual([])
    }
  )

  it.each(['pending', 'unknown'] as const)(
    'refuses a %s dispatch whose turn completed after the teardown witness',
    (dispatchState) => {
      expect(
        resumableSet({
          markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
          items: [turnItem('turn-1', 'completed', 'provider-item-1')],
          submissions: [submission('msg-1', dispatchState)]
        })
      ).toEqual([])
    }
  )

  it('refuses a submission marker the journal has no record of', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'submission', id: 'msg-1' } })],
        items: [],
        submissions: [submission('msg-other', 'pending')]
      })
    ).toEqual([])
  })

  // The two identities must not be interchangeable: a turn marker may never be satisfied by a
  // submission that happens to share its id, or the journal stops being an independent witness.
  it('refuses a turn marker whose id only matches a submission', () => {
    expect(
      resumableSet({
        markers: [marker({ work: { kind: 'turn', id: 'msg-1' } })],
        items: [],
        submissions: [submission('msg-1', 'pending')]
      })
    ).toEqual([])
  })
})

describe('spending a marker', () => {
  function runner(overrides: { resume?: () => Promise<void>; concurrency?: number } = {}) {
    const consumed = new Set<string>()
    const resume = overrides.resume ?? vi.fn(async () => {})
    return {
      resume,
      consumed,
      deps: {
        admission: new StructuredAgentSessionResumeAdmission(),
        // Stands in for the durable store: the first caller spends it, later ones find it gone.
        consumeMarker: async (sessionId: string) => {
          if (consumed.has(sessionId)) {
            return false
          }
          consumed.add(sessionId)
          return true
        },
        resume,
        ...(overrides.concurrency === undefined ? {} : { concurrency: overrides.concurrency })
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

  // A second relaunch finds the marker already spent; nothing may run again.
  it('refuses a marker a previous launch already consumed', async () => {
    const { deps, resume } = runner()
    await resumeStructuredAgentSessionsFromRestart(deps, [candidate(SESSION)], 'first-launch')

    const outcomes = await resumeStructuredAgentSessionsFromRestart(
      deps,
      [candidate(SESSION)],
      'second-launch'
    )

    expect(outcomes).toEqual([
      { sessionId: SESSION, outcome: 'refused', reason: 'agent_session_resume_consumed' }
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
    // Still spent after the failure: the next launch must not retry it on its own.
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

    // Unbounded fan-out would peak at all 12 — which is the spawn storm this exists to prevent.
    expect(peak).toBe(STRUCTURED_AGENT_SESSION_RESUME_CONCURRENCY)
    expect(outcomes).toHaveLength(candidates.length)
  })
})
