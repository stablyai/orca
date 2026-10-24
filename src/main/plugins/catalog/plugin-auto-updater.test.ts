import { describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../../shared/plugins/manifest/plugin-manifest'
import {
  isPluginAutoUpdateOn,
  normalizePluginUpdatePolicySettings,
  type PluginAutoUpdateState
} from '../../../shared/plugins/catalog/plugin-update-policy'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { PLUGIN_AUTO_UPDATE_HOLD_BACK_MS, PluginAutoUpdater } from './plugin-auto-updater'

const KEY = 'samples.demo'
const REPO = 'https://example.com/samples/demo.git'
const HOUR = 60 * 60 * 1000
const COMMIT = 'c'.repeat(40)

function release(version: string) {
  return {
    version,
    commit: COMMIT,
    contentHash: 'sha-new',
    execution: 'trusted-worker' as const,
    minimumOrca: '1.0.0'
  }
}

function manifest(version: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version,
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'worker.js',
    capabilities: [{ kind: 'notifications:show' }],
    ...overrides
  })
}

function discovered(m: PluginManifest, contentHash: string, isDev = false): ValidDiscoveredPlugin {
  return {
    pluginKey: KEY,
    rootDir: `/plugins/${KEY}/${contentHash}`,
    manifest: m,
    consentFingerprint: fingerprintPluginConsent(m, contentHash),
    contentHash,
    isDev
  }
}

function setup(
  options: {
    next?: PluginManifest
    officialCatalog?: boolean
    repository?: string
    approved?: boolean
    disabled?: boolean
    dev?: boolean
    enabled?: boolean
    blocked?: boolean
    pinned?: boolean
    previewCommit?: string
    refreshMs?: number
    killListRefresh?: () => Promise<unknown>
  } = {}
) {
  let now = 1_000_000
  // Why first pass only: later refreshes hit warm caches and finish sooner.
  let refreshMs = options.refreshMs ?? 0
  const previous = discovered(manifest('1.0.0'), 'sha-old', options.dev)
  const nextManifest = options.next ?? manifest('1.1.0')
  const next = discovered(nextManifest, 'sha-new')
  let current = previous
  const consents: Record<string, string> =
    options.approved === false ? {} : { [KEY]: previous.consentFingerprint }
  const firstSeen = new Map<string, { release: string; at: number }>()
  const install = vi.fn(async () => ({
    ok: true as const,
    pluginKey: KEY,
    version: nextManifest.version,
    contentHash: 'sha-new',
    consentFingerprint: next.consentFingerprint,
    resolvedCommit: null
  }))
  const changes: { state: PluginAutoUpdateState; updated: Record<string, string> }[] = []
  const updater = new PluginAutoUpdater({
    pluginService: {
      options: {
        isPluginSystemEnabled: () => true,
        isFullAccessAllowed: () => true,
        getPluginConsents: () => consents,
        getDisabledPlugins: () => (options.disabled ? [KEY] : [])
      },
      getDiscovered: () => [current],
      findValidPlugin: () => current,
      refresh: async () => {
        current = next
      }
    },
    installer: {
      findInstalledUpdateListing: vi.fn(async () => ({
        listing: {
          marketplaceSourceId: 'a'.repeat(32),
          marketplaceName: 'Samples',
          marketplaceOwner: 'samples',
          marketplaceCommit: 'b'.repeat(40),
          pluginKey: KEY,
          source: { kind: 'git' as const, url: REPO, ref: 'main' },
          categories: [],
          official: false,
          bundled: false,
          version: nextManifest.version,
          ...(options.pinned === false ? {} : { release: release(nextManifest.version) }),
          ...(options.blocked ? { blockedByKillList: { reason: 'malware' } } : {})
        },
        officialCatalog: options.officialCatalog === true
      })),
      previewInstalledUpdate: vi.fn(async () => ({
        marketplaceSourceId: 'a'.repeat(32),
        marketplaceName: 'Samples',
        marketplaceOwner: 'samples',
        marketplaceCommit: 'b'.repeat(40),
        pluginKey: KEY,
        source: { kind: 'git' as const, url: options.repository ?? REPO, ref: 'main' },
        ...(options.repository ? { repositoryMoved: true as const } : {}),
        resolvedCommit: options.previewCommit ?? COMMIT,
        contentHash: 'sha-new',
        consentFingerprint: next.consentFingerprint,
        manifest: nextManifest,
        official: false,
        bundled: false
      })),
      install
    },
    firstSeen: {
      firstSeen: async (pluginKey, release, at) => {
        const known = firstSeen.get(pluginKey)
        if (known?.release === release) {
          return known.at
        }
        firstSeen.set(pluginKey, { release, at })
        return at
      }
    },
    isEnabled: () => options.enabled !== false,
    refreshCatalogs: async () => {
      now += refreshMs
      refreshMs = 0
    },
    refreshKillList: options.killListRefresh ?? (async () => undefined),
    approve: async (pluginKey, fingerprint) => {
      consents[pluginKey] = fingerprint
    },
    onChanged: (state, updated) => changes.push({ state, updated }),
    now: () => now
  })
  return {
    updater,
    install,
    consents,
    next,
    changes,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('plugin auto-update', () => {
  it('holds a release back until it has been listed for 12 hours, then installs it in place', async () => {
    const { updater, install, consents, next, changes, advance } = setup()
    await updater.run()
    expect(install).not.toHaveBeenCalled()
    advance(PLUGIN_AUTO_UPDATE_HOLD_BACK_MS - HOUR)
    await updater.run()
    expect(install).not.toHaveBeenCalled()
    advance(HOUR)
    await updater.run()
    expect(install).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledWith(expect.anything(), { requireInstalled: true })
    expect(consents[KEY]).toBe(next.consentFingerprint)
    expect(updater.getState()).toEqual({ updated: { [KEY]: '1.1.0' }, needsReview: {} })
    expect(changes.at(-1)?.updated).toEqual({ [KEY]: '1.1.0' })
  })

  it('installs on the pass one hold later even when the first catalog refresh was slow', async () => {
    const { updater, install, advance } = setup({ refreshMs: 60_000 })
    await updater.run()
    advance(PLUGIN_AUTO_UPDATE_HOLD_BACK_MS - 60_000)
    await updater.run()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('refreshes the kill list before installing and installs nothing when that fails', async () => {
    const order: string[] = []
    const ok = setup({
      officialCatalog: true,
      killListRefresh: async () => order.push('kill-list')
    })
    ok.install.mockImplementation(async () => {
      order.push('install')
      throw new Error('stop')
    })
    await ok.updater.run()
    expect(order).toEqual(['kill-list', 'install'])
    const offline = setup({
      officialCatalog: true,
      killListRefresh: async () => {
        throw new Error('offline')
      }
    })
    await offline.updater.run()
    expect(offline.install).not.toHaveBeenCalled()
  })

  it('installs at once from an official catalog and logs it for hosts without a UI', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { updater, install } = setup({ officialCatalog: true })
    await updater.run()
    expect(install).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(`[plugins] auto-updated ${KEY} to 1.1.0`)
    info.mockRestore()
  })

  it('leaves an update that asks for more access uninstalled and marked for review', async () => {
    const { updater, install, consents } = setup({
      officialCatalog: true,
      next: manifest('1.1.0', {
        capabilities: [{ kind: 'notifications:show' }, { kind: 'terminal:send' }]
      })
    })
    const before = consents[KEY]
    await updater.run()
    expect(install).not.toHaveBeenCalled()
    expect(consents[KEY]).toBe(before)
    expect(updater.getState().needsReview).toEqual({ [KEY]: '1.1.0' })
  })

  it('marks an update from a moved repository for review', async () => {
    const { updater, install } = setup({
      officialCatalog: true,
      repository: 'https://example.com/someone-else/demo.git'
    })
    await updater.run()
    expect(install).not.toHaveBeenCalled()
    expect(updater.getState().needsReview).toEqual({ [KEY]: '1.1.0' })
  })

  it('skips disabled, unapproved, development, blocked plugins and the manual policy', async () => {
    for (const options of [
      { disabled: true },
      { approved: false },
      { dev: true },
      { blocked: true },
      { enabled: false }
    ]) {
      const { updater, install } = setup({ officialCatalog: true, ...options })
      await updater.run()
      expect(install, JSON.stringify(options)).not.toHaveBeenCalled()
    }
  })

  it('never auto-installs an unpinned listing, whose bytes are a moving branch head', async () => {
    const { updater, install, advance } = setup({ pinned: false })
    await updater.run()
    advance(PLUGIN_AUTO_UPDATE_HOLD_BACK_MS)
    await updater.run()
    expect(install).not.toHaveBeenCalled()
  })

  it('installs only the release that was held, not one listed since', async () => {
    const { updater, install } = setup({ officialCatalog: true, previewCommit: 'd'.repeat(40) })
    await updater.run()
    expect(install).not.toHaveBeenCalled()
  })

  it('keeps the policy a bounded union with auto as the default and unknown values manual', () => {
    expect(normalizePluginUpdatePolicySettings({})).toEqual({})
    expect(isPluginAutoUpdateOn({})).toBe(true)
    expect(
      isPluginAutoUpdateOn(
        normalizePluginUpdatePolicySettings({ pluginUpdatePolicy: 'official-only' })
      )
    ).toBe(false)
    expect(normalizePluginUpdatePolicySettings({ pluginUpdatePolicy: 'manual' })).toEqual({
      pluginUpdatePolicy: 'manual'
    })
    expect(normalizePluginUpdatePolicySettings({ pluginUpdatePolicy: 'official-only' })).toEqual({
      pluginUpdatePolicy: 'manual'
    })
  })
})
