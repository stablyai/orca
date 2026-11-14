import type { AgentSessionRecoveryCapsule } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import { agentSessionResumeWitnessKey } from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'
import type { JournalHostDatabase } from '../../agent-session-journal/database/journal-host-database'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

type Inventory = Awaited<ReturnType<AgentSessionRecoveryCapsule['inventory']>>

/** The original finite read waits only for its cohort's necessary Stop evidence, outside action lanes. */
export function createRestartEvidenceReader(input: {
  capsule?: AgentSessionRecoveryCapsule
  database: JournalHostDatabase
  loaded: (sessionId: string) => boolean
  provider: (sessionId: string) => string | undefined
  logger: StructuredAgentSessionLogger
  now: () => number
}) {
  const inventory = () =>
    input.capsule?.inventory(input.now(), (ids) => input.database.history?.retainSessions(ids))
  return async <T>(
    kind: 'pending' | 'failed',
    audience: ((agent: string) => boolean) | undefined,
    consume: (inventory: Inventory) => T | Promise<T>
  ): Promise<T | undefined> => {
    let captured: Inventory | undefined
    try {
      captured = await inventory()
    } catch {
      input.logger.warn('reading restart offers from the recovery capsule failed', {
        scope: 'recovery-capsule-read'
      })
      throw new Error('restart recovery evidence is unavailable')
    }
    if (!captured) {
      return undefined
    }
    const markers =
      kind === 'pending' ? captured.pending : captured.failed.map((failure) => failure.marker)
    const ids = [
      ...new Set(
        markers
          .map((marker) => marker.sessionId)
          .filter((id) => {
            const provider = input.provider(id)
            return provider !== undefined && (!audience || audience(provider))
          })
      )
    ]
    const release = input.database.history?.pinSessions(ids)
    try {
      const results = await Promise.all(
        ids
          .filter((id) => !input.loaded(id))
          .map((id) => input.database.history?.prepareStops(id) ?? Promise.resolve('unavailable'))
      )
      if (results.includes('unavailable')) {
        throw new Error('restart recovery evidence is unavailable')
      }
      const current = await inventory()
      if (!current) {
        throw new Error('restart recovery evidence is unavailable')
      }
      const pending = new Set(current.pending.map(agentSessionResumeWitnessKey))
      const failed = new Set(current.failed.map((failure) => JSON.stringify(failure)))
      return await consume({
        pending: captured.pending.filter((marker) =>
          pending.has(agentSessionResumeWitnessKey(marker))
        ),
        failed: captured.failed.filter((failure) => failed.has(JSON.stringify(failure)))
      })
    } finally {
      release?.()
    }
  }
}
