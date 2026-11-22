import { expect, it } from 'vitest'
import {
  StructuredAgentSessionIdleSweep,
  type StructuredAgentSessionIdleSweepDeps as SweepDeps
} from './structured-agent-session-idle-sweep'

it("a forced release keeps a running turn's agent and stops it once the turn ends", async () => {
  const work = { activeTurn: true }
  const stopped: string[] = []
  const session: { child?: { phase: 'ready'; fence: number } } & Record<string, unknown> = {
    child: { phase: 'ready', fence: 1 },
    journal: {
      readWork: async () => ({ activeTurn: work.activeTurn, actionablePrompt: false }),
      reads: { input: async () => ({ submissions: [] }) }
    }
  }
  const deps = {
    sessions: Object.assign(new Map([['chat', session]]), {
      lastActivityAt: () => 0,
      touch: () => {}
    }),
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    now: () => 1_000,
    isDisposed: () => false,
    deliveryActive: () => false,
    childWorkOpen: () => false,
    hasOpenDispatch: () => false,
    providerHoldsDispatch: () => false,
    confirmIdle: async () => 'idle',
    store: { getConversation: () => null, replacedRuntime: () => undefined },
    stopAgent: async (sessionId: string) => {
      stopped.push(sessionId)
      delete session.child
    },
    stopStartingAgent: async () => {},
    startTimed: () => false,
    closeConversation: async () => true,
    logger: { warn: () => {} }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these sessions' child and journal work reads, which the stubs supply.
  const sweep = new StructuredAgentSessionIdleSweep(deps as unknown as SweepDeps)

  expect(await sweep.release('chat', true)).toBe('busy')
  expect(stopped).toEqual([])
  work.activeTurn = false
  expect(await sweep.release('chat', true)).toBe('stopped')
  expect(stopped).toEqual(['chat'])
  expect(await sweep.release('chat', true)).toBe('not-running')
})
