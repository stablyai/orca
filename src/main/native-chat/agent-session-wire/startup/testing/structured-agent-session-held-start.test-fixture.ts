import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from '../../providers/structured-agent-session-adapter'
import type { SubmissionRejectionFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { AgentSessionStartFailure } from '../structured-agent-session-start-failure'
import {
  providerStartupFailureFact,
  structuredAgentSessionStartFailureFact,
  withObservedProviderExit
} from '../structured-agent-session-failure-text'

type Acquire = StructuredAgentSessionAdapter['acquire']
type Open = StructuredAgentSessionAdapter['open']
type EventHost = { handleAdapterEvent(event: StructuredAgentSessionLifecycleEvent): Promise<void> }

export type StructuredAgentSessionHeldStarts = {
  held(acquire: Acquire): Acquire
  wrap<A extends StructuredAgentSessionAdapter>(adapter: A): A & StructuredAgentSessionAdapter
  prove(child: { sessionId: string; fence: number; acquisitionGeneration: string }): Promise<void>
  clear(): void
}

const EXIT_KINDS = new Set(['providerExited', 'providerStartFailed', 'startFailed'])

/** As an adapter reads its own child's exit: a typed refusal the exit carried stays final, and an
 *  unanswered exit may start once more. */
export function testAdapterStartupEnding(
  failure?: SubmissionRejectionFact
): AgentSessionStartFailure {
  const exited = withObservedProviderExit(new Error('provider exited before open answered'))
  const final = failure && (failure.refusal !== undefined || !EXIT_KINDS.has(failure.kind))
  return new AgentSessionStartFailure(
    exited,
    final ? 'never' : 'safe',
    failure
      ? structuredAgentSessionStartFailureFact({ exit: failure })
      : providerStartupFailureFact(exited)
  )
}

/** Opens wait until proved; as a real adapter, a child's own exit answers its waiting open. */
export function structuredAgentSessionHeldStarts(
  host: () => EventHost | undefined
): StructuredAgentSessionHeldStarts {
  const held = new Map<string, () => void>()
  const waiting = new Map<string, Promise<void>>()
  const endings = new Map<string, AgentSessionStartFailure>()
  const ended = new Map<string, (failure: AgentSessionStartFailure) => void>()
  const observed = new WeakSet<EventHost>()
  const observe = (): void => {
    const target = host()
    if (!target || observed.has(target)) {
      return
    }
    observed.add(target)
    const handle = target.handleAdapterEvent.bind(target)
    target.handleAdapterEvent = async (event) => {
      const ending =
        event.type === 'ended' && event.cause === 'unexpected-exit'
          ? testAdapterStartupEnding(event.failure)
          : undefined
      if (ending && event.type === 'ended') {
        endings.set(event.acquisitionGeneration, ending)
      }
      await handle(event)
      if (ending && event.type === 'ended') {
        ended.get(event.acquisitionGeneration)?.(ending)
      }
    }
  }
  const prove: StructuredAgentSessionHeldStarts['prove'] = async (child) => {
    held.get(child.acquisitionGeneration)?.()
    await Promise.resolve()
  }
  return {
    held: (acquire) => async (input) => {
      observe()
      const acquired = await acquire(input)
      const generation = acquired.acquisitionGeneration
      waiting.set(generation, new Promise<void>((resolve) => held.set(generation, resolve)))
      return acquired
    },
    wrap: (adapter) => {
      const open: Open = async (input) => {
        observe()
        const generation = input.acquisitionGeneration
        const ending = endings.get(generation)
        if (ending) {
          throw ending
        }
        const exit = new Promise<never>((_resolve, reject) => ended.set(generation, reject))
        void exit.catch(() => {})
        try {
          await Promise.race([waiting.get(generation), exit])
          waiting.delete(generation)
          held.delete(generation)
          return await Promise.race([adapter.open(input), exit])
        } finally {
          ended.delete(generation)
        }
      }
      const startupEnding: NonNullable<StructuredAgentSessionAdapter['startupEnding']> = (
        _sessionId,
        generation
      ) => endings.get(generation)
      return { ...adapter, open, startupEnding }
    },
    prove,
    clear: () => {
      for (const resolve of held.values()) {
        resolve()
      }
      held.clear()
      waiting.clear()
      endings.clear()
    }
  }
}
