import { abandonStructuredAgentSessionHost } from './structured-agent-session-host-test-abandon'
import type { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { TrackedTestRecoveryCapsule } from './structured-agent-session-host-test-recovery-capsule'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'

export function createQueuedMessageRigOwnership(
  root: string,
  journals: ReturnType<typeof createTrackedJournalOpener> | null
) {
  const hosts = new Map<StructuredAgentSessionHost, { completed: boolean; crashed: boolean }>()
  const capsules: TrackedTestRecoveryCapsule[] = []
  let ownedStore: Awaited<ReturnType<typeof openTestAgentSessionRecordStore>> | undefined
  const ownHost = (host: StructuredAgentSessionHost) => {
    if (journals) {
      const state = { completed: false, crashed: false }
      hosts.set(host, state)
      const flush = host.flushAllStreamedEvents.bind(host)
      host.flushAllStreamedEvents = (...args) => {
        const operation = flush(...args)
        void operation.then(
          () => {
            state.completed = true
          },
          () => {}
        )
        return operation
      }
    }
    return host
  }
  const disposeOwned = async () => {
    const failures: unknown[] = []
    const stopped: Promise<unknown>[] = []
    for (const [host, state] of hosts) {
      if (state.completed) {
        continue
      }
      for (const stop of [
        () => host.stopDelivery(),
        () => host['lifetime'].dispose(),
        () => host['runtimeState'].acquireAborts.abortAll('closed by test cleanup'),
        () => {
          const operation = Promise.resolve(host['runtimeState'].stopLeaseRenewal())
          void operation.catch(() => undefined)
          stopped.push(operation)
        }
      ]) {
        try {
          stop()
        } catch (error) {
          failures.push(error)
        }
      }
    }
    for (const result of await Promise.allSettled(stopped)) {
      if (result.status === 'rejected') {
        failures.push(result.reason)
      }
    }
    for (const capsule of capsules) {
      try {
        await capsule.settled({ inspect: true })
      } catch (error) {
        failures.push(error)
      }
    }
    for (const [host, state] of hosts) {
      if (state.completed) {
        continue
      }
      try {
        if (state.crashed) {
          await abandonStructuredAgentSessionHost(host, { cleanup: true })
          state.completed = true
        } else {
          await host.flushAllStreamedEvents()
        }
      } catch (error) {
        failures.push(error)
      }
    }
    for (const capsule of capsules) {
      try {
        await capsule.settled({ inspect: true })
      } catch (error) {
        failures.push(error)
      }
    }
    if (ownedStore) {
      try {
        await ownedStore.renewLeases([])
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 0) {
      try {
        await journals!.dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `queued profile retained: ${root}`, {
        cause: { hosts, capsules, ownedStore, journals }
      })
    }
    hosts.clear()
    capsules.splice(0)
    ownedStore = undefined
  }
  return {
    hosts,
    capsules,
    ownHost,
    disposeOwned,
    setOwnedStore: (store: NonNullable<typeof ownedStore>) => {
      ownedStore = store
    }
  }
}
