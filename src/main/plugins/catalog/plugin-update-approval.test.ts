import { describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { installCatalogReleaseWithApproval } from './plugin-update-approval'

const KEY = 'samples.demo'

type ManifestOverrides = Omit<Partial<PluginManifest>, 'contributes'> & {
  contributes?: Partial<PluginManifest['contributes']>
}

function manifest(overrides: ManifestOverrides = {}): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    capabilities: [],
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

const SAMPLES = {
  data: () => manifest({ contributes: { languagePacks: [{ locale: 'fr', path: 'fr.json' }] } }),
  declarative: () =>
    manifest({
      capabilities: [],
      contributes: {
        commands: [{ id: 'demo.open', title: 'Open', action: 'sidebar.left.toggle' }],
        keybindings: [{ command: 'demo.open', key: 'CmdOrCtrl+Shift+9' }]
      }
    }),
  'sandboxed-ui': () =>
    manifest({ contributes: { panels: [{ id: 'dash', title: 'Dash', entry: 'panel.html' }] } }),
  'trusted-worker': () =>
    manifest({ main: 'worker.js', capabilities: [{ kind: 'notifications:show' }] })
} satisfies Record<string, () => PluginManifest>

/** Runs an update from `before` (approved unless `approved: false`) to `after`. */
async function runUpdate(options: {
  before: PluginManifest
  after: PluginManifest
  approved?: boolean
  repositoryMoved?: boolean
  dev?: boolean
}) {
  const previous = discovered(options.before, 'sha-old', options.dev)
  const next = discovered(options.after, 'sha-new')
  let current = previous
  const consents: Record<string, string> = {}
  if (options.approved !== false) {
    consents[KEY] = previous.consentFingerprint
  }
  const approve = vi.fn(async (pluginKey: string, fingerprint: string) => {
    consents[pluginKey] = fingerprint
  })
  const outcome = await installCatalogReleaseWithApproval({
    pluginKey: KEY,
    pluginService: {
      options: {
        isPluginSystemEnabled: () => true,
        isFullAccessAllowed: () => true,
        getPluginConsents: () => consents,
        getDisabledPlugins: () => []
      },
      findValidPlugin: () => current,
      refresh: async () => {
        current = next
      }
    },
    install: async () => ({
      ok: true,
      pluginKey: KEY,
      version: '1.1.0',
      contentHash: 'sha-new',
      resolvedCommit: null,
      consentFingerprint: next.consentFingerprint,
      ...(options.repositoryMoved ? { repositoryMoved: true as const } : {})
    }),
    approve
  })
  return { outcome, approve, consents, next }
}

describe('catalog update approval', () => {
  for (const [type, sample] of Object.entries(SAMPLES)) {
    it(`keeps a ${type} plugin approved when an update changes only its content`, async () => {
      const before = sample()
      const after = { ...sample(), version: '1.1.0' }
      const { outcome, consents, next } = await runUpdate({ before, after })
      expect(outcome).toMatchObject({ ok: true, needsReview: false })
      expect(consents[KEY]).toBe(next.consentFingerprint)
    })

    it(`asks again when a ${type} update adds a capability`, async () => {
      const before = sample()
      const after = {
        ...sample(),
        version: '1.1.0',
        main: 'worker.js',
        capabilities: [...before.capabilities, { kind: 'terminal:send' as const }]
      }
      const { outcome, approve } = await runUpdate({ before, after })
      expect(outcome).toMatchObject({ ok: true, needsReview: true })
      expect(approve).not.toHaveBeenCalled()
    })
  }

  it('asks again when the execution profile rises', async () => {
    const { outcome, approve } = await runUpdate({
      before: SAMPLES.data(),
      after: SAMPLES['sandboxed-ui']()
    })
    expect(outcome).toMatchObject({ needsReview: true })
    expect(approve).not.toHaveBeenCalled()
  })

  it('asks again for a new global shortcut, command, panel or event', async () => {
    const declarative = SAMPLES.declarative()
    const newShortcut = manifest({
      contributes: {
        ...declarative.contributes,
        keybindings: [{ command: 'demo.open', key: 'CmdOrCtrl+Shift+8' }]
      }
    })
    const panel = SAMPLES['sandboxed-ui']()
    const newPanel = manifest({
      contributes: {
        panels: [...panel.contributes.panels, { id: 'more', title: 'More', entry: 'more.html' }]
      }
    })
    const worker = SAMPLES['trusted-worker']()
    const newEvent = manifest({
      main: 'worker.js',
      capabilities: [{ kind: 'notifications:show' }, { kind: 'workspace:read' }],
      contributes: { events: [{ on: 'workspace.created' }] }
    })
    const workerWithRead = manifest({
      main: 'worker.js',
      capabilities: [{ kind: 'notifications:show' }, { kind: 'workspace:read' }]
    })
    for (const [before, after] of [
      [declarative, newShortcut],
      [panel, newPanel],
      [workerWithRead, newEvent]
    ] as const) {
      const { outcome } = await runUpdate({ before, after })
      expect(outcome).toMatchObject({ needsReview: true })
    }
    // Removing access never re-asks.
    const { outcome } = await runUpdate({ before: workerWithRead, after: worker })
    expect(outcome).toMatchObject({ needsReview: false })
  })

  it('always asks again for a moved repository, a development override or no prior approval', async () => {
    const before = SAMPLES['trusted-worker']()
    const after = { ...before, version: '1.1.0' }
    for (const options of [{ repositoryMoved: true }, { dev: true }, { approved: false }]) {
      const { outcome, approve } = await runUpdate({ before, after, ...options })
      expect(approve).not.toHaveBeenCalled()
      expect(outcome.ok).toBe(true)
      if (options.repositoryMoved) {
        expect(outcome).toMatchObject({ needsReview: true })
      }
    }
  })
})
