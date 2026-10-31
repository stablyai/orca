import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { RestTestRig } from './structured-agent-session-rest-test-rig'

export function createRestTestOwnership(
  root: string,
  ownership: {
    scoped?: true
    closeAdapter?: () => Promise<void>
    waitForRecovery?: () => Promise<void>
  }
) {
  const profiles = new Map<
    string,
    {
      journals: ReturnType<typeof createTrackedJournalOpener>
      database?: ReturnType<typeof openTestJournalHostDatabase>
      hosts: Map<StructuredAgentSessionHost, { completed: boolean }>
      stores: Map<AgentSessionRecordStore, ReturnType<typeof openTestJournalHostDatabase>>
      adapters: Set<() => Promise<void>>
      errors: unknown[]
      stopped: Promise<unknown>[]
    }
  >()
  const ownProfile: RestTestRig['ownProfile'] = (directory) => {
    if (!ownership.scoped) {
      throw new Error('scoped ownership must precede acquisition')
    }
    let profile = profiles.get(directory)
    if (!profile) {
      profile = {
        journals: createTrackedJournalOpener({ scoped: true }),
        hosts: new Map(),
        stores: new Map(),
        adapters: new Set(),
        errors: [],
        stopped: []
      }
      profile.journals.ownRoot(directory)
      profiles.set(directory, profile)
    }
    const owned = profile
    return {
      database: () => (owned.database = owned.journals.database(directory)),
      openJournal: (options) => owned.journals.open({ ...options, stateDirectory: directory }),
      store: (store) => {
        owned.stores.set(store, owned.database!)
        return store
      },
      host: (host) => {
        owned.database = owned.journals.database(directory, host.deps.journalDatabase)
        if (!owned.hosts.has(host)) {
          const state = { completed: false }
          owned.hosts.set(host, state)
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
      },
      closeAdapter: (close) => {
        owned.adapters.add(close)
      }
    }
  }
  const owned = ownership.scoped ? ownProfile(root) : null
  if (ownership.closeAdapter) {
    owned?.closeAdapter(ownership.closeAdapter)
  }
  const ownHost = (host: StructuredAgentSessionHost) => owned?.host(host) ?? host
  const disposeOwned = async () => {
    const ownedProfiles = [...profiles]
    profiles.clear()
    for (const [, profile] of ownedProfiles) {
      for (const [host, state] of profile.hosts) {
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
    const waitForRecovery = async () => {
      try {
        await ownership.waitForRecovery?.()
      } catch (error) {
        for (const [, profile] of ownedProfiles) {
          profile.errors.push(error)
        }
      }
    }
    await waitForRecovery()
    for (const [, profile] of ownedProfiles) {
      for (const result of await Promise.allSettled(profile.stopped)) {
        if (result.status === 'rejected') {
          profile.errors.push(result.reason)
        }
      }
      for (const [host, state] of profile.hosts) {
        if (state.completed) {
          continue
        }
        try {
          await host.flushAllStreamedEvents()
        } catch (error) {
          profile.errors.push(error)
        }
      }
      for (const close of profile.adapters) {
        try {
          await close()
        } catch (error) {
          profile.errors.push(error)
        }
      }
    }
    await waitForRecovery()
    for (const [, profile] of ownedProfiles) {
      for (const [store, database] of profile.stores) {
        if (database.isClosed || database.readOnly) {
          continue
        }
        try {
          await store.renewLeases([])
        } catch (error) {
          profile.errors.push(error)
        }
      }
      if (profile.errors.length === 0) {
        try {
          await profile.journals.closeAll()
        } catch (error) {
          profile.errors.push(error)
        }
      }
    }
    const blocked = ownedProfiles
      .filter(([, profile]) => profile.errors.length > 0)
      .map(([directory]) => directory)
    for (const [directory, profile] of [...ownedProfiles].sort(([a], [b]) => b.length - a.length)) {
      try {
        await profile.journals.dispose(undefined, blocked)
      } catch (error) {
        blocked.push(directory)
        profile.errors.push(error)
      }
    }
    const failures = ownedProfiles.flatMap(([directory, profile]) =>
      profile.errors.length > 0
        ? [
            new AggregateError(profile.errors, `REST profile retained: ${directory}`, {
              cause: profile
            })
          ]
        : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'owned REST cleanup failed')
    }
  }
  return { ownProfile, owned, ownHost, disposeOwned }
}
