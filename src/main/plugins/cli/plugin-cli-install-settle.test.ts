import { describe, expect, it, vi } from 'vitest'
import { installCatalogReleaseWithApproval } from '../catalog/plugin-update-approval'
import { PLUGIN_INSTALL_FAILED_CODE } from '../../../shared/plugins/approval/plugin-cli-approval'
import { settlePluginCliCandidate, type PluginCliInstallDeps } from './plugin-cli-install'
import type { PluginCliInstallCandidate } from './plugin-cli-install-candidates'

// Why these three: settling reads only them, and the update is never a repository move or an access grant.
vi.mock('../catalog/plugin-update-approval', () => ({
  installCatalogReleaseWithApproval: vi.fn(),
  readApprovedPredecessor: () => null,
  readPreviewAccessGrowth: vi.fn()
}))

const URL = 'https://github.com/samples/demo.git'
const PLUGIN_KEY = 'samples.demo'

/** Settles an update whose bytes are 1.1.0; the lockfile says what is installed after the attempt. */
function settle(installed: { version: string; contentHash: string } | null) {
  const lock = {
    plugins: installed
      ? {
          [PLUGIN_KEY]: {
            pluginKey: PLUGIN_KEY,
            version: installed.version,
            contentHash: installed.contentHash,
            resolvedCommit: 'a'.repeat(40),
            source: { kind: 'git', url: URL, ref: 'main' }
          }
        }
      : {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the fields settling reads
  const candidate = {
    pluginKey: PLUGIN_KEY,
    manifest: { version: '1.1.0' },
    contentHash: 'new-hash',
    consentFingerprint: 'fingerprint',
    resolvedCommit: 'b'.repeat(40),
    source: { kind: 'git', url: URL, ref: 'main' },
    location: { kind: 'repository', url: URL },
    install: vi.fn(),
    dispose: async () => undefined
  } as unknown as PluginCliInstallCandidate
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the catalog lockfile and approval fields settling touches are provided
  const deps = {
    service: {
      options: { getPluginConsents: () => ({}), getDisabledPlugins: () => [] },
      findValidPlugin: () => null,
      recordApprovalAudit: async () => undefined
    },
    catalogs: { installer: { readInstallLockfile: async () => lock } },
    applyConsent: vi.fn(),
    executionHost: 'the Orca host',
    caller: undefined
  } as unknown as PluginCliInstallDeps
  return settlePluginCliCandidate(deps, candidate, 'update', undefined)
}

describe('settlePluginCliCandidate after a failure', () => {
  it('reports the installed version when a step after the write fails', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockRejectedValueOnce(
      new Error('catalog refresh failed')
    )
    const failure = await settle({ version: '1.1.0', contentHash: 'new-hash' }).then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toMatchObject({
      code: PLUGIN_INSTALL_FAILED_CODE,
      message:
        'samples.demo 1.1.0 is installed, but finishing the install failed: catalog refresh failed',
      data: { pluginKey: PLUGIN_KEY, version: '1.1.0', installed: true }
    })
  })

  it('keeps the original error when the target version did not land', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockRejectedValueOnce(
      new Error('catalog refresh failed')
    )
    await expect(settle({ version: '1.0.0', contentHash: 'old-hash' })).rejects.toThrow(
      'catalog refresh failed'
    )
  })

  it('keeps the original error when nothing is installed', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockRejectedValueOnce(
      new Error('catalog refresh failed')
    )
    await expect(settle(null)).rejects.toThrow('catalog refresh failed')
  })
})
