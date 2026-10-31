import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/approval/plugin-consent-fingerprint'
import { PluginApprovalRequiredError } from '../../shared/plugins/approval/plugin-cli-approval'
import { parsePluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import { pluginCliApprovalRequest } from './plugin-cli-approval'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { loadPluginDevFolder, unloadPluginDevFolder } from './plugin-dev-folders'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function devPlugin(rootDir: string, raw: Record<string, unknown>): ValidDiscoveredPlugin {
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    id: 'demo',
    publisher: 'acme',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.4.245' },
    ...raw
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return {
    pluginKey: 'acme.demo',
    rootDir,
    manifest: parsed.manifest,
    consentFingerprint: fingerprintPluginConsent(parsed.manifest, 'dev-identity'),
    consentContentHash: 'dev-identity',
    contentHash: null,
    isDev: true
  }
}

const THEME = {
  execution: 'data',
  contributes: { themes: [{ id: 'dusk', title: 'Dusk', path: 'themes/dusk.json' }] }
}
const PANEL = {
  execution: 'sandboxed-ui',
  pluginApi: 1,
  contributes: { panels: [{ id: 'p', title: 'P', entry: 'panel.html' }] }
}

async function harness(raw: Record<string, unknown>, enabled = true) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'orca-dev-folder-')))
  roots.push(folder)
  let devPaths: string[] = []
  let discovered: DiscoveredPlugin[] = []
  const consents: Record<string, string> = {}
  const applyConsent = vi.fn(async ({ pluginKey, reviewedFingerprint }) => {
    consents[pluginKey] = reviewedFingerprint
  })
  const service = {
    options: {
      isPluginSystemEnabled: () => enabled,
      getDevPluginPaths: () => devPaths,
      getPluginConsents: () => consents,
      getDisabledPlugins: () => []
    },
    refresh: vi.fn(async () => {
      discovered = devPaths.map((path) => devPlugin(path, raw))
    }),
    getDiscovered: () => discovered,
    findValidPlugin: (key: string) =>
      discovered.find((plugin): plugin is ValidDiscoveredPlugin => plugin.pluginKey === key) ??
      null,
    recordApprovalAudit: vi.fn().mockResolvedValue(undefined)
  }
  const writes = {
    setDevPluginPaths: (paths: string[]) => {
      devPaths = paths
    },
    applyConsent
  }
  return { folder, service, writes, applyConsent, devPaths: () => devPaths }
}

describe('plugin development folders over the CLI', () => {
  it('activates a content-only folder at once', async () => {
    const { folder, service, writes, devPaths } = await harness(THEME)
    await expect(
      loadPluginDevFolder({ service, writes, path: folder, caller: { kind: 'local-cli' } })
    ).resolves.toMatchObject({ pluginKey: 'acme.demo', added: true, approval: 'content-only' })
    expect(devPaths()).toEqual([folder])
  })

  it('keeps code inert without --approve and grants with the shown fingerprint', async () => {
    const { folder, service, writes, applyConsent, devPaths } = await harness(PANEL)
    const refusal = await loadPluginDevFolder({
      service,
      writes,
      path: folder,
      caller: { kind: 'local-cli' }
    }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(PluginApprovalRequiredError)
    expect(devPaths()).toEqual([folder])
    expect(applyConsent).not.toHaveBeenCalled()

    const fingerprint = pluginCliApprovalRequest(
      devPlugin(folder, PANEL),
      'dev-load'
    ).approvalFingerprint
    await expect(
      loadPluginDevFolder({
        service,
        writes,
        path: folder,
        approvalFingerprint: fingerprint,
        caller: { kind: 'local-cli' }
      })
    ).resolves.toMatchObject({ added: false, approval: 'approve-flag' })
    expect(devPaths()).toEqual([folder])
  })

  it('refuses relative paths and a host with plugins off', async () => {
    const { service, writes } = await harness(THEME)
    await expect(
      loadPluginDevFolder({ service, writes, path: 'relative/dir', caller: undefined })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    const off = await harness(THEME, false)
    await expect(
      loadPluginDevFolder({
        service: off.service,
        writes: off.writes,
        path: off.folder,
        caller: undefined
      })
    ).rejects.toMatchObject({ code: 'plugin_system_disabled' })
  })

  it('unloads by plugin key or folder', async () => {
    const { folder, service, writes, devPaths } = await harness(THEME)
    await loadPluginDevFolder({ service, writes, path: folder, caller: undefined })
    await expect(
      unloadPluginDevFolder({ service, writes, target: { pluginKey: 'acme.demo' } })
    ).resolves.toEqual({ path: folder, pluginKey: 'acme.demo' })
    expect(devPaths()).toEqual([])
    await expect(
      unloadPluginDevFolder({ service, writes, target: { path: folder } })
    ).rejects.toMatchObject({ code: 'plugin_not_found' })
  })
})
