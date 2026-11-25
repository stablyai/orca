import { describe, expect, it, vi } from 'vitest'
import { installCatalogReleaseWithApproval } from '../catalog/plugin-update-approval'
import {
  buildPluginApprovalRequest,
  PLUGIN_APPROVAL_REQUIRED_CODE,
  PLUGIN_INSTALL_FAILED_CODE,
  PluginApprovalRequiredError
} from '../../../shared/plugins/approval/plugin-cli-approval'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { approvePluginFromCli } from './plugin-cli-approval'
import { settlePluginCliCandidate, type PluginCliInstallDeps } from './plugin-cli-install'
import type { PluginCliInstallCandidate } from './plugin-cli-install-candidates'

// Why these three: settling reads only them, and the update is never a repository move or an access grant.
vi.mock('../catalog/plugin-update-approval', () => ({
  installCatalogReleaseWithApproval: vi.fn(),
  readApprovedPredecessor: () => null,
  readPreviewAccessGrowth: vi.fn()
}))
// Why: the post-write approval is the step under test; its outcome is set per case.
vi.mock('./plugin-cli-approval', () => ({ approvePluginFromCli: vi.fn() }))

const URL = 'https://github.com/samples/demo.git'
const OTHER_URL = 'https://github.com/other/demo.git'
const PLUGIN_KEY = 'samples.demo'
const NEW_HASH = 'new-hash'

// Why data: a content-only plugin's approval is not asked before the write, so only the post-write step can refuse.
const dataManifest = pluginManifestSchema.parse({
  manifestVersion: 2,
  id: 'demo',
  publisher: 'samples',
  name: 'Demo',
  version: '1.1.0',
  execution: 'data',
  license: 'MIT',
  engines: { orca: '>=1.4.248' },
  capabilities: [],
  contributes: {}
})

type InstalledFixture = {
  version: string
  contentHash: string
  /** Where the lockfile says the installed bytes came from; defaults to the candidate's repository. */
  url?: string
  /** The commit the lockfile recorded; defaults to a commit that differs from the candidate's. */
  commit?: string
}

function lockOf(installed: InstalledFixture | null) {
  return {
    plugins: installed
      ? {
          [PLUGIN_KEY]: {
            pluginKey: PLUGIN_KEY,
            version: installed.version,
            contentHash: installed.contentHash,
            resolvedCommit: installed.commit ?? 'a'.repeat(40),
            source: { kind: 'git', url: installed.url ?? URL, ref: 'main' }
          }
        }
      : {}
  }
}

/**
 * Settles an update of 1.1.0 bytes. The lockfile is read twice: `before` when settling starts, and
 * `installed` after the write, which is what recovery reads.
 */
function settle(
  installed: InstalledFixture | null,
  options: { action?: 'install' | 'update'; before?: InstalledFixture | null } = {}
) {
  const readInstallLockfile = vi
    .fn()
    .mockResolvedValueOnce(lockOf(options.before ?? null))
    .mockResolvedValue(lockOf(installed))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the fields settling reads
  const candidate = {
    pluginKey: PLUGIN_KEY,
    manifest: dataManifest,
    contentHash: NEW_HASH,
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
    catalogs: { installer: { readInstallLockfile } },
    applyConsent: vi.fn(),
    executionHost: 'the Orca host',
    caller: undefined
  } as unknown as PluginCliInstallDeps
  return settlePluginCliCandidate(deps, candidate, options.action ?? 'update', undefined)
}

function failureOf(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => null,
    (error: unknown) => error
  )
}

/** The write landed: the install reports the new bytes, and the approval step is what settles next. */
function landedInstall(needsReview: boolean) {
  return {
    ok: true as const,
    pluginKey: PLUGIN_KEY,
    version: '1.1.0',
    contentHash: NEW_HASH,
    consentFingerprint: 'fingerprint',
    resolvedCommit: 'b'.repeat(40),
    needsReview
  }
}

describe('settlePluginCliCandidate after a failure', () => {
  it('reports the installed version when a step after the write fails', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockRejectedValueOnce(
      new Error('catalog refresh failed')
    )
    const failure = await failureOf(settle({ version: '1.1.0', contentHash: NEW_HASH }))
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

  it('keeps the original error when the same bytes came from another repository', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockRejectedValueOnce(
      new Error('catalog refresh failed')
    )
    // Why: same version and bytes, but the lockfile's install came from a different repository.
    const failure = await failureOf(
      settle({ version: '1.1.0', contentHash: NEW_HASH, url: OTHER_URL })
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: 'catalog refresh failed' })
    expect(failure).not.toMatchObject({ code: PLUGIN_INSTALL_FAILED_CODE })
  })

  it('keeps its approval error and names the installed version when approval is owed after the write', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockResolvedValueOnce(landedInstall(true))
    const request = buildPluginApprovalRequest(
      {
        pluginKey: PLUGIN_KEY,
        manifest: dataManifest,
        consentFingerprint: 'fingerprint',
        contentIdentity: NEW_HASH,
        isDev: false
      },
      'install'
    )
    vi.mocked(approvePluginFromCli).mockRejectedValueOnce(new PluginApprovalRequiredError(request))
    const failure = await failureOf(
      settle({ version: '1.1.0', contentHash: NEW_HASH }, { action: 'install' })
    )
    expect(failure).toBeInstanceOf(PluginApprovalRequiredError)
    expect(failure).toMatchObject({
      code: PLUGIN_APPROVAL_REQUIRED_CODE,
      message: expect.stringMatching(
        /^samples\.demo 1\.1\.0 is installed, but its approval is still pending\./
      ),
      data: {
        pluginKey: PLUGIN_KEY,
        version: '1.1.0',
        approvalFingerprint: request.approvalFingerprint,
        installed: { version: '1.1.0' },
        source: { kind: 'git', url: URL, ref: 'main' }
      }
    })
  })

  it('keeps the plain approval error when the same bytes came from another repository', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockResolvedValueOnce(landedInstall(true))
    const request = buildPluginApprovalRequest(
      {
        pluginKey: PLUGIN_KEY,
        manifest: dataManifest,
        consentFingerprint: 'fingerprint',
        contentIdentity: NEW_HASH,
        isDev: false
      },
      'install'
    )
    const original = new PluginApprovalRequiredError(request)
    vi.mocked(approvePluginFromCli).mockRejectedValueOnce(original)
    const failure = await failureOf(
      settle({ version: '1.1.0', contentHash: NEW_HASH, url: OTHER_URL }, { action: 'install' })
    )
    // Why: the lockfile's install is not this candidate, so the approval error must not claim it.
    expect(failure).toBe(original)
  })
})

describe('settlePluginCliCandidate when the bytes match an installed record', () => {
  it('reports the record source and keeps the requested source apart when another repository published them', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockResolvedValueOnce(landedInstall(false))
    const outcome = await settle(
      { version: '1.1.0', contentHash: NEW_HASH, url: OTHER_URL },
      { action: 'install' }
    )
    expect(outcome.source).toMatchObject({
      kind: 'git',
      url: OTHER_URL,
      repository: 'github.com/other/demo',
      commit: 'a'.repeat(40)
    })
    expect(outcome.requestedSource).toMatchObject({ url: URL })
    expect(outcome.resolvedCommit).toBe('a'.repeat(40))
  })

  it('reports the recorded commit and keeps the requested commit apart when the same repository published the bytes at another commit', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockResolvedValueOnce(landedInstall(false))
    const outcome = await settle({ version: '1.1.0', contentHash: NEW_HASH }, { action: 'install' })
    expect(outcome.source).toMatchObject({ url: URL, commit: 'a'.repeat(40) })
    expect(outcome.requestedSource).toMatchObject({ url: URL })
    expect(outcome.resolvedCommit).toBe('a'.repeat(40))
  })

  it('reports the requested source and no separate request when the record matches the request', async () => {
    vi.mocked(installCatalogReleaseWithApproval).mockResolvedValueOnce(landedInstall(false))
    const outcome = await settle(
      { version: '1.1.0', contentHash: NEW_HASH, commit: 'b'.repeat(40) },
      { action: 'install' }
    )
    expect(outcome.source).toMatchObject({ url: URL, ref: 'main' })
    expect(outcome.requestedSource).toBeUndefined()
    expect(outcome.resolvedCommit).toBe('b'.repeat(40))
  })
})
