import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { PluginUsageReading } from '../../../../shared/plugins/contributions/plugin-usage-provider-contribution'
import { subscribeRuntimeAccountChanges } from './runtime-account-change-subscription'
import type { AccountsSnapshot } from './runtime-account-controller'

it('layers plugin readings over the newest valid account snapshot during and after a roster read', async () => {
  const accounts = { accounts: [], activeAccountId: null }
  const initialUsage = createEmptyRateLimitState()
  const nextUsage = createEmptyRateLimitState({ cursorAuthConfigured: true })
  const reading: PluginUsageReading = {
    pluginKey: 'samples.quota',
    providerId: 'sample-quota',
    label: 'Sample quota',
    status: 'ok',
    accounts: [{ label: 'Sample account', windows: [{ label: '5h', usedPercent: 25 }] }],
    observedAt: 1
  }
  const delayedRoster = Promise.withResolvers<AccountsSnapshot['codex']>()
  const snapshots: AccountsSnapshot[] = []
  let onRename!: () => void
  let streamReads = 0
  let generations: readonly [number, number] = [0, 0]
  let onUsageChanged!: (usage: AccountsSnapshot['rateLimits']) => void
  let onPluginUsageChanged!: (readings: PluginUsageReading[]) => void
  let pluginUsageProviders: PluginUsageReading[] = []
  let rosterReads = 0
  let failUsageRead = false
  let streamUsage = initialUsage
  let failStreamReads = false
  const removeListener = () => () => {}
  const services: Parameters<typeof subscribeRuntimeAccountChanges>[0] = {
    claudeAccounts: { listAccounts: () => accounts, onAccountRenamed: removeListener },
    codexAccounts: {
      listAccounts: () => {
        if (failUsageRead) {
          return Promise.reject(new Error('Temporary usage read failure'))
        }
        return rosterReads++ === 0 ? delayedRoster.promise : Promise.resolve(accounts)
      },
      onAccountRenamed: (listener) => {
        onRename = listener
        return () => {}
      }
    },
    rateLimits: {
      onStateChange: (listener: typeof onUsageChanged) => {
        onUsageChanged = listener
        return () => {}
      },
      getAccountRefreshGenerations: () => generations
    },
    pluginUsageProviders: {
      onChanged: (listener: typeof onPluginUsageChanged) => {
        onPluginUsageChanged = listener
        return () => {}
      },
      snapshot: () => pluginUsageProviders
    }
  }
  const { initialize, unsubscribe } = subscribeRuntimeAccountChanges(
    services,
    {
      stream: async () => {
        if (++streamReads === 2 || failStreamReads) {
          throw new Error('Temporary account read failure')
        }
        return { claude: accounts, codex: accounts, rateLimits: streamUsage }
      },
      dataAccounts: () => ({})
    },
    (snapshot) => snapshots.push(snapshot)
  )

  try {
    await initialize((snapshot) => snapshots.push(snapshot))
    pluginUsageProviders = [reading]
    onPluginUsageChanged(pluginUsageProviders)
    expect(snapshots.splice(0)).toEqual([
      { claude: accounts, codex: accounts, rateLimits: initialUsage, pluginUsageProviders: [] },
      { claude: accounts, codex: accounts, rateLimits: initialUsage, pluginUsageProviders }
    ])

    onUsageChanged(initialUsage)
    generations = [0, 1]
    onUsageChanged(nextUsage)
    pluginUsageProviders = [{ ...reading, observedAt: 2 }]
    onPluginUsageChanged(pluginUsageProviders)
    delayedRoster.resolve(accounts)
    await setImmediate()

    expect(snapshots.splice(0)).toEqual([
      { claude: accounts, codex: accounts, rateLimits: initialUsage, pluginUsageProviders: [] },
      { claude: accounts, codex: accounts, rateLimits: nextUsage, pluginUsageProviders }
    ])

    pluginUsageProviders = []
    onPluginUsageChanged(pluginUsageProviders)
    expect(snapshots[0]).toEqual({
      claude: accounts,
      codex: accounts,
      rateLimits: nextUsage,
      pluginUsageProviders: []
    })
    expect(rosterReads).toBe(2)

    pluginUsageProviders = [reading]
    onPluginUsageChanged(pluginUsageProviders)
    expect(snapshots.at(-1)?.pluginUsageProviders).toEqual([reading])

    generations = [0, 2]
    onRename()
    pluginUsageProviders = []
    onPluginUsageChanged(pluginUsageProviders)
    await setImmediate()
    expect(snapshots.at(-1)?.pluginUsageProviders).toEqual([])
    expect(streamReads).toBe(3)

    const snapshotsBeforeFailure = snapshots.length
    streamUsage = nextUsage
    failUsageRead = true
    onUsageChanged(nextUsage)
    await setImmediate()
    expect(snapshots).toHaveLength(snapshotsBeforeFailure)
    failUsageRead = false
    pluginUsageProviders = [reading]
    onPluginUsageChanged(pluginUsageProviders)
    await setImmediate()
    expect(snapshots.at(-1)).toMatchObject({ rateLimits: nextUsage, pluginUsageProviders })

    const unchanged = { ...reading, providerId: 'second-quota' }
    const replacement = {
      ...reading,
      accounts: [{ label: 'Sample account', windows: [{ label: '5h', usedPercent: 50 }] }]
    }
    pluginUsageProviders = [reading, unchanged]
    onPluginUsageChanged(pluginUsageProviders)

    failStreamReads = true
    onRename()
    pluginUsageProviders = [replacement, unchanged]
    onPluginUsageChanged(pluginUsageProviders)
    await setImmediate()
    expect(snapshots.at(-1)).toMatchObject({
      rateLimits: nextUsage,
      pluginUsageProviders: [unchanged]
    })

    failStreamReads = false
    onPluginUsageChanged(pluginUsageProviders)
    await setImmediate()
    expect(snapshots.at(-1)).toMatchObject({
      rateLimits: nextUsage,
      pluginUsageProviders: [replacement, unchanged]
    })
  } finally {
    unsubscribe()
  }
})
