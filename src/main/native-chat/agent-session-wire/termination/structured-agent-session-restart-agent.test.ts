import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  restartStructuredAgentSessionAgent,
  type StructuredAgentSessionRestartAgentHost
} from './structured-agent-session-restart-agent'

const { work, stopAgent } = vi.hoisted(() => ({
  work: {
    activeTurnId: vi.fn((): string | null => null),
    hasActionablePrompt: vi.fn(() => false)
  },
  stopAgent: vi.fn(async () => {})
}))
vi.mock('../observations/structured-agent-session-host-current-work', () => ({
  heldStructuredAgentSessionCurrentWork: () => work
}))
vi.mock('./structured-agent-session-host-lifetime', () => ({
  stopStructuredAgentSessionAgentUnderSerialize: stopAgent
}))
vi.mock('../../../../shared/agent-session/requests/agent-session-queued-submission', () => ({
  isQueuedAgentJournalSubmission: (submission: { kind: string }) => submission.kind === 'queued'
}))

const SESSION = 'claude_restart'
const context = { deps: { store: {} } }

function rig(options: {
  child?: { phase: string; close?: object } | null
  queued?: boolean
  deliveryActive?: boolean
  childWorkOpen?: boolean
  hasOpenDispatch?: boolean
}) {
  const serialize = vi.fn(<T>(_id: string, task: () => Promise<T>) => task())
  const session =
    options.child === null
      ? undefined
      : {
          child: options.child ?? { phase: 'running' },
          journal: {
            inputOrder: {
              recoverableSubmissions: () => (options.queued ? [{ kind: 'queued' }] : [])
            }
          }
        }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements only the fields restartStructuredAgentSessionAgent reads; store and stop are mocked above.
  const host = {
    context: () => context,
    sessions: { get: (id: string) => (id === SESSION ? session : undefined) },
    serialize,
    deliveryActive: () => options.deliveryActive === true,
    childWorkOpen: () => options.childWorkOpen === true,
    hasOpenDispatch: () => options.hasOpenDispatch === true,
    providerHoldsDispatch: () => false
  } as unknown as StructuredAgentSessionRestartAgentHost
  return { host, serialize }
}

describe('restartStructuredAgentSessionAgent', () => {
  beforeEach(() => {
    work.activeTurnId.mockReturnValue(null)
    work.hasActionablePrompt.mockReturnValue(false)
    stopAgent.mockClear()
  })

  it('stops an idle agent at rest under session serialization', async () => {
    const { host, serialize } = rig({})
    await expect(restartStructuredAgentSessionAgent(host, SESSION, false)).resolves.toEqual({
      restarted: true
    })
    expect(serialize).toHaveBeenCalledWith(SESSION, expect.any(Function))
    expect(stopAgent).toHaveBeenCalledWith(context, SESSION, { cause: 'evict', resting: true })
  })

  it('reports a chat with no running agent', async () => {
    for (const child of [null, { phase: 'running', close: {} }]) {
      const { host } = rig({ child })
      await expect(restartStructuredAgentSessionAgent(host, SESSION, true)).resolves.toEqual({
        restarted: false,
        reason: 'not-running'
      })
    }
    expect(stopAgent).not.toHaveBeenCalled()
  })

  it('never cuts a turn, prompt, queued send or start, even when forced', async () => {
    const cases: (() => ReturnType<typeof rig>)[] = [
      () => rig({ child: { phase: 'starting' } }),
      () => rig({ deliveryActive: true }),
      () => rig({ queued: true }),
      () => {
        work.activeTurnId.mockReturnValue('turn-1')
        return rig({})
      },
      () => {
        work.hasActionablePrompt.mockReturnValue(true)
        return rig({})
      }
    ]
    for (const make of cases) {
      work.activeTurnId.mockReturnValue(null)
      work.hasActionablePrompt.mockReturnValue(false)
      const { host } = make()
      await expect(restartStructuredAgentSessionAgent(host, SESSION, true)).resolves.toEqual({
        restarted: false,
        reason: 'busy'
      })
    }
    expect(stopAgent).not.toHaveBeenCalled()
  })

  it('asks before stopping background work, and stops it when forced', async () => {
    for (const background of [{ childWorkOpen: true }, { hasOpenDispatch: true }]) {
      stopAgent.mockClear()
      const asked = rig(background)
      await expect(restartStructuredAgentSessionAgent(asked.host, SESSION, false)).resolves.toEqual(
        { restarted: false, reason: 'background-work' }
      )
      expect(stopAgent).not.toHaveBeenCalled()
      const forced = rig(background)
      await expect(restartStructuredAgentSessionAgent(forced.host, SESSION, true)).resolves.toEqual(
        { restarted: true }
      )
      expect(stopAgent).toHaveBeenCalledTimes(1)
    }
  })
})
