import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { TrackedTestRecoveryCapsule } from './structured-agent-session-host-test-recovery-capsule'

export type OwnedHostTestProfiles = {
  root: string
  journals: ReturnType<typeof createTrackedJournalOpener>
  stores: Map<AgentSessionRecordStore, ReturnType<typeof openTestJournalHostDatabase>>
  hosts: Map<StructuredAgentSessionHost, { completed: boolean }>
  capsules: Set<TrackedTestRecoveryCapsule>
  database?: ReturnType<typeof openTestJournalHostDatabase>
  errors: unknown[]
  stopped: Promise<unknown>[]
}[]
export async function drainOwnedHostTestProfiles(profiles: OwnedHostTestProfiles): Promise<void> {
  const failures: unknown[] = []
  for (const profile of profiles) {
    for (const [host, state] of profile.hosts) {
      if (!state.completed) {
        for (const stop of [
          () => host.stopDelivery(),
          () => host['lifetime'].dispose(),
          () => host['runtimeState'].acquireAborts.abortAll('closed by test cleanup'),
          () => {
            const operation = Promise.resolve(host['runtimeState'].stopLeaseRenewal())
            void operation.catch(() => undefined)
            profile.stopped.push(operation)
          }
        ]) {
          try {
            stop()
          } catch (error) {
            profile.errors.push(error)
          }
        }
      }
    }
  }
  for (const profile of profiles) {
    const errors = profile.errors
    for (const result of await Promise.allSettled(profile.stopped)) {
      if (result.status === 'rejected') {
        errors.push(result.reason)
      }
    }
    for (const capsule of profile.capsules) {
      try {
        await capsule.settled({ inspect: true })
      } catch (error) {
        errors.push(error)
      }
    }
    for (const [host, state] of profile.hosts) {
      if (state.completed) {
        continue
      }
      try {
        await host.flushAllStreamedEvents()
      } catch (error) {
        errors.push(error)
      }
    }
    for (const capsule of profile.capsules) {
      try {
        await capsule.settled({ inspect: true })
      } catch (error) {
        errors.push(error)
      }
    }
    for (const [store, database] of profile.stores) {
      if (database.isClosed || database.readOnly) {
        continue
      }
      try {
        await store.renewLeases([])
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 0) {
      try {
        await profile.journals.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      failures.push(
        new AggregateError(errors, `host profile retained: ${profile.root}`, { cause: profile })
      )
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'owned host cleanup failed')
  }
}
