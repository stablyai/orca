import { evictAgentSessionOwner } from '../../runtime/agent-session-lease-transitions'
import type {
  StructuredAgentSessionHandoffDeps,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

export async function closeRetainedTuiOwner(input: {
  sessionId: string
  deps: StructuredAgentSessionHandoffDeps
  owner: (sessionId: string) => StructuredTuiOwner | undefined
  requireRecord: (sessionId: string) => { lease: { runtimeFence: number } }
  releaseOwner: (sessionId: string) => void
}): Promise<boolean> {
  const owner = input.owner(input.sessionId)
  if (!owner) {
    return false
  }
  const close = input.deps.transport?.closeTuiOwner ?? input.deps.transport?.waitForTuiExit
  if (!close) {
    throw new Error('The owning agent terminal could not be stopped.')
  }
  await close(owner)
  const record = input.requireRecord(input.sessionId)
  await input.deps.store.transitionHandoff(input.sessionId, (current) =>
    evictAgentSessionOwner({
      record: current,
      expectedFence: record.lease.runtimeFence,
      probe: { outcome: 'exit-observed' },
      now: input.deps.now()
    })
  )
  input.releaseOwner(input.sessionId)
  return true
}
