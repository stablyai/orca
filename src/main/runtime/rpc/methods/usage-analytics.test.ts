import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod } from '../core'
import {
  RuntimeUsageAnalyticsController,
  type RuntimeUsageAnalyticsStores,
  type UsageAnalyticsProvider
} from '../../runtime-usage-analytics-controller'
import {
  GetUsageAnalyticsSnapshotParams,
  UsageAnalyticsProviderParams
} from '../../../../shared/rpc-contract/usage-analytics-params'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { USAGE_ANALYTICS_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import { USAGE_ANALYTICS_METHODS } from './usage-analytics'

function method(name: string) {
  const found = eraseRpcMethods(USAGE_ANALYTICS_METHODS).find((m) => m.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing request method ${name}`)
  }
  return found
}

function makeStore(label: string) {
  let loaded = false
  return {
    whenLoaded: vi.fn(async () => {
      loaded = true
    }),
    getScanState: vi.fn(() => ({ label, loaded })),
    setEnabled: vi.fn(async (enabled: boolean) => ({ label, enabled })),
    refresh: vi.fn(async (force?: boolean) => ({ label, force })),
    getSnapshot: vi.fn((scope: string, range: string, limit?: number) => ({
      label,
      loaded,
      scope,
      range,
      limit
    }))
  }
}

function makeRuntime(stores?: RuntimeUsageAnalyticsStores): OrcaRuntimeService {
  const controller = new RuntimeUsageAnalyticsController()
  if (stores) {
    controller.setStores(stores)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the usage methods only call these runtime members.
  return {
    getUsageAnalyticsScanState: controller.getScanState.bind(controller),
    setUsageAnalyticsEnabled: controller.setEnabled.bind(controller),
    refreshUsageAnalytics: controller.refresh.bind(controller),
    getUsageAnalyticsSnapshot: controller.getSnapshot.bind(controller)
  } as unknown as OrcaRuntimeService
}

function makeStores() {
  return {
    claude: makeStore('claude'),
    codex: makeStore('codex'),
    opencode: makeStore('opencode'),
    muse: makeStore('muse')
  }
}

describe('usage analytics RPC methods', () => {
  it('advertises the capability clients gate on', () => {
    expect(RUNTIME_CAPABILITIES).toContain(USAGE_ANALYTICS_RUNTIME_CAPABILITY)
  })

  it.each(['claude', 'codex', 'opencode', 'muse'] as const)(
    'reads %s scan state and snapshot only after persisted state loads',
    async (provider: UsageAnalyticsProvider) => {
      const stores = makeStores()
      const runtime = makeRuntime(stores)

      await expect(
        method('usage.getScanState').handler({ provider }, { runtime })
      ).resolves.toEqual({ label: provider, loaded: true })
      await expect(
        method('usage.getSnapshot').handler(
          { provider, scope: 'all', range: '7d', limit: 10 },
          { runtime }
        )
      ).resolves.toEqual({ label: provider, loaded: true, scope: 'all', range: '7d', limit: 10 })
      for (const [name, store] of Object.entries(stores)) {
        expect(store.getScanState).toHaveBeenCalledTimes(name === provider ? 1 : 0)
      }
    }
  )

  it('forwards enable and refresh to the named provider', async () => {
    const stores = makeStores()
    const runtime = makeRuntime(stores)

    await method('usage.setEnabled').handler({ provider: 'codex', enabled: true }, { runtime })
    await method('usage.refresh').handler({ provider: 'muse' }, { runtime })
    await method('usage.refresh').handler({ provider: 'claude', force: true }, { runtime })

    expect(stores.codex.setEnabled).toHaveBeenCalledWith(true)
    expect(stores.muse.refresh).toHaveBeenCalledWith(false)
    expect(stores.claude.refresh).toHaveBeenCalledWith(true)
  })

  it('refuses instead of answering with defaults before the stores are wired', async () => {
    await expect(
      method('usage.getScanState').handler({ provider: 'claude' }, { runtime: makeRuntime() })
    ).rejects.toThrow(/not available on this host/)
  })

  it('only accepts known providers and a bounded session limit', () => {
    expect(UsageAnalyticsProviderParams.safeParse({ provider: 'grok' }).success).toBe(false)
    expect(
      GetUsageAnalyticsSnapshotParams.safeParse({
        provider: 'claude',
        scope: 'orca',
        range: '30d',
        limit: 10_000
      }).success
    ).toBe(false)
  })
})
