// A fake adapter whose child proves its start the moment it is published, as a provider with an
// instant handshake does. Every acquire answers before its handshake now, so a fake that should
// behave like a ready provider reports `started` itself; the host queues it behind the attach
// that publishes the child.

import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent
} from './structured-agent-session-adapter'

/** A report read at this revision is never admitted, so the fake's empty report persists nothing,
 *  as a fake with no options to report never did. */
const NO_OPTIONS_REPORTED = -1

export function startsWhenPublished<A extends StructuredAgentSessionAdapter>(
  adapter: A,
  host: () => { handleAdapterEvent(event: StructuredAgentSessionLifecycleEvent): Promise<void> }
): A {
  let generations = 0
  const acquire: StructuredAgentSessionAdapter['acquire'] = async (input) => {
    const acquired = await adapter.acquire(input)
    const acquisitionGeneration = acquired.acquisitionGeneration ?? `instant-start-${++generations}`
    void host().handleAdapterEvent({
      type: 'started',
      sessionId: input.identity.sessionId,
      fence: input.fence,
      acquisitionGeneration,
      reportedOptions: { model: '' },
      restoreSkippedOptions: [],
      optionRevision: NO_OPTIONS_REPORTED
    })
    return { ...acquired, acquisitionGeneration }
  }
  return { ...adapter, acquire }
}
