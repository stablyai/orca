import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { PluginAuditLog } from '../logging/plugin-audit-log'
import {
  createPluginServiceHostCall,
  resolvePluginServiceHostCallPolicy
} from '../runtime/plugin-service-host-call'
import { STALE_THRESHOLD_MS } from '../../rate-limits/service/service-types'
import { PluginUsageProviderState } from './plugin-usage-provider-state'

function plugin(id: string, contentHash: string, provider: string): ValidDiscoveredPlugin {
  return {
    pluginKey: `samples.${id}`,
    rootDir: tmpdir(),
    contentHash,
    consentFingerprint: 'approved',
    isDev: false,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      id,
      publisher: 'samples',
      name: 'Sample plugin',
      version: '1.0.0',
      engines: { orca: '>=1.4.278' },
      pluginApi: 1,
      execution: 'trusted-worker',
      main: 'worker.js',
      contributes: { usageProviders: [{ id: provider, label: 'Sample quota' }] }
    })
  }
}

describe('plugin usage worker authority', () => {
  it('rejects another plugin’s provider and a previous worker of the same install key', async () => {
    const original = plugin('first', 'old-tree', 'first-quota')
    const replacement = plugin('first', 'new-tree', 'first-quota')
    const other = plugin('second', 'other-tree', 'second-quota')
    const approved = new Map([
      [original.pluginKey, original],
      [other.pluginKey, other]
    ])
    const findApprovedPlugin = (key: string) => approved.get(key) ?? null
    const usageProviders = new PluginUsageProviderState(findApprovedPlugin)
    const audit = new PluginAuditLog(tmpdir())
    const call = createPluginServiceHostCall((pluginKey, caller) =>
      resolvePluginServiceHostCallPolicy({
        pluginKey,
        caller,
        findApprovedPlugin,
        usageProviders,
        pluginsDataDir: tmpdir(),
        panels: null,
        desktop: null,
        sinks: {},
        audit,
        runtimeDelegate: {
          resolveActiveWorktreeContext: async () => null,
          listTerminals: async () => ({ terminals: [] }),
          sendTerminal: async () => ({ accepted: false }),
          dispatchPluginNotification: async () => ({ delivered: false })
        }
      })
    )
    const publish = (worker: ValidDiscoveredPlugin, id: string, usedPercent: number) =>
      call(
        worker.pluginKey,
        'usageProvider.update',
        {
          id,
          status: 'ok',
          accounts: [
            { label: 'Shared account', plan: 'Pro', windows: [{ label: '5h', usedPercent }] },
            { label: 'Backup account', windows: [{ label: '5h', usedPercent: 10 }] }
          ]
        },
        'worker',
        { isCurrentWorker: () => approved.get(worker.pluginKey) === worker }
      )

    try {
      expect(await publish(original, 'second-quota', 100)).toMatchObject({ code: 'invalid_params' })
      expect(await publish(original, 'first-quota', 25)).toMatchObject({ ok: true })
      approved.set(replacement.pluginKey, replacement)
      expect(usageProviders.snapshot()).toEqual([])
      expect(await publish(replacement, 'first-quota', 50)).toMatchObject({ ok: true })
      expect(await publish(original, 'first-quota', 100)).toMatchObject({
        code: 'consent_required'
      })
      expect(usageProviders.snapshot()).toEqual([
        {
          pluginKey: 'samples.first',
          pluginName: 'Sample plugin',
          providerId: 'first-quota',
          label: 'Sample quota',
          observedAt: expect.any(Number),
          status: 'ok',
          accounts: [
            { label: 'Shared account', plan: 'Pro', windows: [{ label: '5h', usedPercent: 50 }] },
            { label: 'Backup account', windows: [{ label: '5h', usedPercent: 10 }] }
          ]
        }
      ])
    } finally {
      usageProviders.dispose()
    }
  })
})

it('publishes expiry when the clock crosses the deadline during reconciliation', async () => {
  const source = plugin('sample', 'tree', 'quota')
  const state = new PluginUsageProviderState(() => source)
  const published: number[] = []
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const now = vi.spyOn(Date, 'now')
  try {
    state.onChanged((readings) => published.push(readings.length))
    state.update(source, {
      id: 'quota',
      status: 'ok',
      accounts: [{ label: 'Sample', windows: [{ label: '5h', usedPercent: 25 }] }]
    })

    now.mockReturnValueOnce(STALE_THRESHOLD_MS - 1).mockReturnValue(STALE_THRESHOLD_MS)
    state.reconcile()
    await vi.advanceTimersByTimeAsync(1)

    expect(published).toEqual([1, 0])
  } finally {
    state.dispose()
    now.mockRestore()
    vi.useRealTimers()
  }
})
