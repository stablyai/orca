import { hasAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getManagedDataAccountService } from '../../../managed-data-accounts/service'
import type { AccountsSnapshot, RuntimeAccountServices } from './runtime-account-controller'
import { runtimePluginUsageSnapshot } from './runtime-account-snapshot'

type AccountChangeServices = {
  claudeAccounts: Pick<
    RuntimeAccountServices['claudeAccounts'],
    'listAccounts' | 'onAccountRenamed'
  >
  codexAccounts: Pick<RuntimeAccountServices['codexAccounts'], 'listAccounts' | 'onAccountRenamed'>
  rateLimits: Pick<
    RuntimeAccountServices['rateLimits'],
    'getAccountRefreshGenerations' | 'onStateChange'
  >
  pluginUsageProviders?: RuntimeAccountServices['pluginUsageProviders']
}

type AccountSnapshotVersion = { revision: number; generations: readonly [number, number] }

/** Republishes the account stream on usage, data-account and account-name changes. */
export function subscribeRuntimeAccountChanges(
  services: AccountChangeServices,
  snapshots: {
    stream: () => Promise<AccountsSnapshot>
    dataAccounts: () => Pick<AccountsSnapshot, 'opencode' | 'devin'>
  },
  listener: (snapshot: AccountsSnapshot) => void
) {
  let active = true
  let revision = 0
  let running = false
  let pending: (AccountSnapshotVersion & { usage?: AccountsSnapshot['rateLimits'] }) | undefined
  let pendingPluginUsage: AccountsSnapshot['pluginUsageProviders']
  let lastPublished: AccountsSnapshot | undefined
  let lastValid: { version: AccountSnapshotVersion; snapshot: AccountsSnapshot } | undefined
  const currentVersion = (): AccountSnapshotVersion => ({
    revision,
    generations: services.rateLimits.getAccountRefreshGenerations()
  })
  const isCurrent = (version: AccountSnapshotVersion): boolean => {
    const current = currentVersion()
    return (
      active &&
      version.revision === current.revision &&
      version.generations.every((generation, index) => generation === current.generations[index])
    )
  }
  const publish = (snapshot: AccountsSnapshot, send = listener) => {
    send(snapshot)
    if (services.pluginUsageProviders) {
      lastPublished = snapshot
    }
  }
  const clearRemovedPluginUsage = (
    current: NonNullable<AccountsSnapshot['pluginUsageProviders']>
  ) => {
    const previous = lastPublished
    if (!previous?.pluginUsageProviders?.length) {
      return
    }
    // Revocations must reach the client even if account reads keep failing. Retain only data
    // already delivered on this connection, and never add a new reading without a valid roster.
    const retained = previous.pluginUsageProviders.filter((reading) =>
      current.some(
        (candidate) =>
          candidate.pluginKey === reading.pluginKey &&
          candidate.providerId === reading.providerId &&
          candidate.iconRevision === reading.iconRevision
      )
    )
    if (retained.length < previous.pluginUsageProviders.length) {
      try {
        publish({ ...previous, pluginUsageProviders: retained })
      } catch (error) {
        console.warn('[accounts] Failed to publish account snapshot', error)
      }
    }
  }
  const publishPluginUsage = (pluginUsageProviders: AccountsSnapshot['pluginUsageProviders']) => {
    if (!pluginUsageProviders || !active) {
      return
    }
    if (!lastValid || !isCurrent(lastValid.version)) {
      clearRemovedPluginUsage(pluginUsageProviders)
      // A quota change may be the only notification after a failed roster refresh.
      queueSnapshot()
      return
    }
    try {
      publish({ ...lastValid.snapshot, pluginUsageProviders })
    } catch (error) {
      console.warn('[accounts] Failed to publish account snapshot', error)
    }
  }
  const queueSnapshot = (usage?: AccountsSnapshot['rateLimits']) => {
    if (!active) {
      return
    }
    pending = { ...currentVersion(), usage }
    if (running) {
      return
    }
    running = true
    void (async () => {
      try {
        while (active && pending) {
          const change = pending
          pending = undefined
          try {
            const snapshot = change.usage
              ? {
                  ...snapshots.dataAccounts(),
                  claude: services.claudeAccounts.listAccounts(),
                  codex: await services.codexAccounts.listAccounts(),
                  rateLimits: change.usage
                }
              : await snapshots.stream()
            if (isCurrent(change)) {
              lastValid = { version: change, snapshot }
              pendingPluginUsage = undefined
              publish({ ...snapshot, ...runtimePluginUsageSnapshot(services) })
            }
          } catch (error) {
            lastValid = undefined
            console.warn('[accounts] Failed to publish account snapshot', error)
          }
        }
      } finally {
        running = false
        // Each coalesced quota change can request at most one replacement read.
        const readings = pendingPluginUsage
        pendingPluginUsage = undefined
        publishPluginUsage(readings)
      }
    })()
  }
  const refreshRoster = () => {
    revision++
    queueSnapshot()
  }
  const unsubscribeData = hasAppEnvironment()
    ? getManagedDataAccountService().onChanged(refreshRoster)
    : () => {}
  const unsubscribeUsage = services.rateLimits.onStateChange(queueSnapshot)
  const unsubscribePluginUsage = services.pluginUsageProviders?.onChanged(
    (pluginUsageProviders) => {
      if (running) {
        clearRemovedPluginUsage(pluginUsageProviders)
        pendingPluginUsage = pluginUsageProviders
      } else {
        publishPluginUsage(pluginUsageProviders)
      }
    }
  )
  // A rename changes no usage, so without this other clients would show the old name.
  const unsubscribeRenames = [services.claudeAccounts, services.codexAccounts].map((accounts) =>
    accounts.onAccountRenamed(refreshRoster)
  )
  return {
    async initialize(ready: (snapshot: AccountsSnapshot) => void): Promise<void> {
      const version = currentVersion()
      const initial = await snapshots.stream()
      if (!active) {
        return
      }
      if (lastValid && isCurrent(lastValid.version)) {
        publish({ ...lastValid.snapshot, ...runtimePluginUsageSnapshot(services) }, ready)
        return
      }
      if (isCurrent(version)) {
        lastValid = { version, snapshot: initial }
      }
      publish({ ...initial, ...runtimePluginUsageSnapshot(services) }, ready)
    },
    unsubscribe() {
      active = false
      pending = undefined
      pendingPluginUsage = undefined
      lastValid = undefined
      lastPublished = undefined
      unsubscribeData()
      unsubscribeUsage()
      unsubscribePluginUsage?.()
      unsubscribeRenames.forEach((unsubscribe) => unsubscribe())
    }
  }
}
