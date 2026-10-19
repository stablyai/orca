// Resumes start agents a few at a time host-wide. A continuation is a send, so a chat counts as started
// once its agent took the message or its start failed — not when the message was accepted, which
// is instant and would let every agent start at once.

import { expect, it, vi } from 'vitest'
import {
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationDeps
} from './structured-agent-session-restart-continuation'
import {
  resumeStructuredAgentSessionsFromRestart,
  StructuredAgentSessionResumeAdmission
} from './structured-agent-session-restart-resume-runner'
import { marker } from './structured-agent-session-restart-resume-test-harness'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

type Handover = { dispatchState: string; reason?: string | null } | undefined

const LIMIT = 3

it('publishes queued chats separately from the chat holding the start slot', async () => {
  const first = Promise.withResolvers<void>()
  const phases = new Map<string, string>()
  const action = resumeStructuredAgentSessionsFromRestart(
    {
      admission: new StructuredAgentSessionResumeAdmission(1),
      onPhase: (sessionId, phase) => phases.set(sessionId, phase),
      consumeMarker: async () => true,
      resume: async (sessionId) => {
        if (sessionId === 'a') {
          await first.promise
        }
      }
    },
    ['a', 'b'].map((sessionId) => ({
      sessionId,
      workspaceId: 'folder',
      executionHostId: 'local',
      workspaceKind: 'folder',
      agent: 'codex',
      work: { kind: 'turn', id: 'turn' },
      trigger: 'quit',
      recordedAt: 1,
      latestPrompt: ''
    })),
    'modal'
  )
  try {
    await vi.waitFor(() => expect(phases.get('a')).toBe('starting'))
    expect(phases.get('b')).toBe('queued')
  } finally {
    first.resolve()
    await action
  }
  expect(phases.get('b')).toBe('starting')
})

it('holds each slot from accept until handover or rejection, and frees it when the wait ends (P2-27)', async () => {
  const handovers = new Map<string, PromiseWithResolvers<Handover>>()
  let waiting = 0
  let mostWaiting = 0
  const deps = (sessionId: string): StructuredAgentSessionContinuationDeps => ({
    currentFence: () => 1,
    send: vi.fn(async () => ({ ok: true, value: { submission: { dispatchState: 'pending' } } })),
    awaitHandedOver: async () => {
      const handover = Promise.withResolvers<Handover>()
      handovers.set(sessionId, handover)
      waiting += 1
      mostWaiting = Math.max(mostWaiting, waiting)
      try {
        return await handover.promise
      } finally {
        waiting -= 1
      }
    },
    awaitSettlement: async () => ({ dispatchState: 'accepted' }),
    note: async () => undefined,
    logger: createStructuredAgentSessionLogger()
  })
  const sessions = Array.from({ length: 8 }, (_, index) => `session-${index}`)
  const outcomes = resumeStructuredAgentSessionsFromRestart(
    {
      admission: new StructuredAgentSessionResumeAdmission(LIMIT),
      consumeMarker: async () => true,
      resume: async (sessionId) => {
        const started = await startStructuredAgentSessionContinuation(
          deps(sessionId),
          sessionId,
          marker(),
          'operation-1'
        )
        if ('done' in started && started.done.outcome === 'refused') {
          throw new Error(started.done.reason ?? 'refused')
        }
      }
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner reads only each candidate's session id.
    sessions.map((sessionId) => ({ sessionId }) as never),
    'modal'
  )
  const settle = async (sessionId: string, handover: Handover) => {
    await vi.waitFor(() => expect(handovers.has(sessionId)).toBe(true))
    handovers.get(sessionId)!.resolve(handover)
  }

  await vi.waitFor(() => expect(waiting).toBe(LIMIT))
  // Accepted but not yet handed over: a slow start keeps its slot.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(handovers.size).toBe(LIMIT)
  await settle('session-0', { dispatchState: 'pending' })
  await settle('session-1', { dispatchState: 'rejected', reason: 'Codex could not start.' })
  // The session closed, or too many waited: the wait proves nothing, and the slot is freed.
  await settle('session-2', undefined)
  for (const sessionId of sessions.slice(3)) {
    await settle(sessionId, { dispatchState: 'pending' })
  }

  const results = await outcomes
  expect(mostWaiting).toBe(LIMIT)
  expect(results.find((result) => result.sessionId === 'session-1')).toMatchObject({
    outcome: 'refused',
    reason: 'Codex could not start.'
  })
  expect(results.filter((result) => result.outcome === 'resumed')).toHaveLength(7)
})
