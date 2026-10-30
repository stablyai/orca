import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_MANIFEST_FILENAME,
  isQualifiedPluginKey,
  type PluginManifest
} from '../../../shared/plugins/manifest/plugin-manifest'
import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN,
  pluginInstallSourceSchema,
  type PluginLockEntry
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { readPluginLockfile } from './plugin-install-lockfile-store'
import { serializePluginMutation } from './plugin-mutation-queue'
import {
  inspectPluginInstallTree,
  installStagedPluginTree,
  type PluginInstallResult
} from './plugin-install-staging'
import { checkoutPluginGitSource } from './plugin-git-repository'
import { findPluginRollbackCandidate } from './plugin-rollback-candidate'
import { readPluginInstallProvenance } from './plugin-install-provenance'
import { publishPluginInstall } from './plugin-install-publication'
import {
  gitUrlPluginPublisher,
  localPluginPublisher
} from '../../../shared/plugins/installation/plugin-publisher-derivation'
import {
  isSameGitRepository,
  splitQualifiedPluginKey
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { readPluginManifestText } from '../plugin-manifest-file'

export type { PluginInstallResult } from './plugin-install-staging'

export { removeInstalledPlugin, retireBundledPlugin } from './plugin-removal'

export {
  PLUGIN_LOCKFILE_MAX_BYTES,
  pluginLockfilePath,
  readPluginLockfile
} from './plugin-install-lockfile-store'

// Use system Git credentials without install scripts; publish immutable trees atomically and retain one rollback.

export async function installPluginFromLocalPath(input: {
  pluginsDir: string
  sourcePath: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  return serializePluginMutation(input.pluginsDir, async () => {
    if (!existsSync(join(input.sourcePath, PLUGIN_MANIFEST_FILENAME))) {
      return { ok: false, error: `no ${PLUGIN_MANIFEST_FILENAME} found in ${input.sourcePath}` }
    }
    const reinstall = await installedPublisherFor(
      input.pluginsDir,
      (source) => source.kind === 'local-path' && source.path === input.sourcePath
    )
    return installStagedPluginTree({
      pluginsDir: input.pluginsDir,
      stagingDir: input.sourcePath,
      hostVersion: input.hostVersion,
      source: { kind: 'local-path', path: input.sourcePath },
      resolvedCommit: null,
      identity: {
        publisher: reinstall ?? localPluginPublisher(await declaredPublisher(input.sourcePath))
      },
      blockedPluginReason: input.blockedPluginReason
    })
  })
}

export async function installBundledPlugin(input: {
  pluginsDir: string
  sourcePath: string
  hostVersion: string
  expectedPluginKey: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  return serializePluginMutation(input.pluginsDir, () =>
    installStagedPluginTree({
      pluginsDir: input.pluginsDir,
      stagingDir: input.sourcePath,
      hostVersion: input.hostVersion,
      source: { kind: 'bundled', bundleId: input.expectedPluginKey },
      resolvedCommit: null,
      identity: { pluginKey: input.expectedPluginKey },
      repairCorruptedVersion: true,
      blockedPluginReason: input.blockedPluginReason
    })
  )
}

export async function installPluginFromGit(input: {
  pluginsDir: string
  url: string
  /** `#ref` suffix: branch, tag, or full commit SHA. Empty = default branch. */
  ref: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  if (!isAllowedPluginGitUrl(input.url)) {
    return { ok: false, error: 'plugin Git URL must use HTTPS or SSH' }
  }
  return serializePluginMutation(input.pluginsDir, async () => {
    // Why reuse: an install from before derived publishers keeps the key its data is stored under.
    const reinstall = await installedPublisherFor(
      input.pluginsDir,
      (source) => source.kind === 'git' && isSameGitRepository(source.url, input.url)
    )
    const stagingDir = await mkdtemp(join(tmpdir(), 'orca-plugin-install-'))
    try {
      const ref = input.ref.trim()
      const resolvedCommit = await checkoutPluginGitSource({
        url: input.url,
        ref,
        destination: stagingDir,
        workingDirectory: tmpdir()
      })
      // Why the declared one last: a URL with no owner segment (`host/repo.git`) names nobody.
      const publisher =
        reinstall ?? gitUrlPluginPublisher(input.url) ?? (await declaredPublisher(stagingDir))
      if (!publisher) {
        return {
          ok: false,
          error: 'cannot name a publisher for this Git URL; use one with an owner (host/owner/repo)'
        }
      }
      return await installStagedPluginTree({
        pluginsDir: input.pluginsDir,
        stagingDir,
        hostVersion: input.hostVersion,
        source: { kind: 'git', url: input.url, ref },
        resolvedCommit,
        identity: { publisher },
        blockedPluginReason: input.blockedPluginReason
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })
}

export async function installPluginFromMarketplace(input: {
  pluginsDir: string
  hostVersion: string
  expectedPluginKey: string
  expectedResolvedCommit: string
  marketplace: { url: string; ref: string; resolvedCommit: string }
  plugin: { url: string; ref: string; path?: string }
  release?: PluginCatalogRelease
  blockedPluginReason?: (pluginKey: string) => string | null
  manifestError?: (manifest: PluginManifest) => string | null
  /** Only replace an install from this marketplace; set by auto-update so Remove wins a race. */
  requireInstalled?: boolean
}): Promise<PluginInstallResult> {
  const source = pluginInstallSourceSchema.parse({
    kind: 'marketplace',
    marketplace: input.marketplace,
    plugin: input.plugin
  })
  if (!isQualifiedPluginKey(input.expectedPluginKey)) {
    return { ok: false, error: 'invalid marketplace plugin identity' }
  }
  if (!PLUGIN_COMMIT_PATTERN.test(input.expectedResolvedCommit)) {
    return { ok: false, error: 'invalid previewed plugin commit' }
  }
  return serializePluginMutation(input.pluginsDir, async () => {
    const entry = (await readPluginLockfile(input.pluginsDir)).plugins[input.expectedPluginKey]
    const installedFrom = entry?.source.kind === 'marketplace' ? entry.source.marketplace : null
    if (input.requireInstalled && installedFrom?.url !== input.marketplace.url) {
      return { ok: false, error: 'plugin was removed before its update installed' }
    }
    // Why: a second catalog listing the same id must never take over an install silently.
    if (
      installedFrom &&
      (installedFrom.url !== input.marketplace.url || installedFrom.ref !== input.marketplace.ref)
    ) {
      return {
        ok: false,
        error: `${input.expectedPluginKey} is installed from ${installedFrom.url}; remove it first to install it from another catalog`
      }
    }
    const stagingDir = await mkdtemp(join(tmpdir(), 'orca-plugin-marketplace-install-'))
    try {
      const resolvedCommit = await checkoutPluginGitSource({
        url: input.plugin.url,
        ref: input.release?.commit ?? input.plugin.ref,
        ...(input.plugin.path ? { path: input.plugin.path } : {}),
        destination: stagingDir,
        workingDirectory: tmpdir()
      })
      if (resolvedCommit !== input.expectedResolvedCommit) {
        return { ok: false, error: 'plugin source changed after preview; review the update again' }
      }
      return await installStagedPluginTree({
        pluginsDir: input.pluginsDir,
        stagingDir,
        hostVersion: input.hostVersion,
        source,
        resolvedCommit,
        identity: { pluginKey: input.expectedPluginKey },
        ...(input.release ? { release: input.release } : {}),
        blockedPluginReason: input.blockedPluginReason,
        manifestError: input.manifestError
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })
}

/** Rollback restores prior content identity; enablement still requires consent for those exact bytes. */
export async function rollbackInstalledPlugin(input: {
  pluginsDir: string
  pluginKey: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  if (!isQualifiedPluginKey(input.pluginKey)) {
    return { ok: false, error: 'invalid qualified plugin key' }
  }
  const blockedReason = input.blockedPluginReason?.(input.pluginKey)
  if (blockedReason) {
    return { ok: false, error: `plugin is blocked by Orca's safety list: ${blockedReason}` }
  }
  return serializePluginMutation(input.pluginsDir, async () => {
    const pluginDir = join(input.pluginsDir, input.pluginKey)
    const candidate = await findPluginRollbackCandidate(pluginDir)
    if (!candidate.ok) {
      return candidate
    }
    const { contentHash } = candidate
    const provenance = await readPluginInstallProvenance(pluginDir, contentHash)
    if (
      !provenance ||
      provenance.pluginKey !== input.pluginKey ||
      provenance.contentHash !== contentHash
    ) {
      return { ok: false, error: 'rollback version has no valid install provenance' }
    }
    const inspection = await inspectPluginInstallTree({
      rootDir: join(pluginDir, contentHash),
      hostVersion: input.hostVersion,
      identity: { pluginKey: input.pluginKey }
    })
    if (!inspection.ok || inspection.contentHash !== contentHash) {
      return {
        ok: false,
        error: inspection.ok ? 'rollback version failed integrity verification' : inspection.error
      }
    }
    try {
      await publishPluginInstall({ pluginsDir: input.pluginsDir, pluginDir, entry: provenance })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return {
      ok: true,
      pluginKey: input.pluginKey,
      version: inspection.manifest.version,
      contentHash,
      consentFingerprint: provenance.consentFingerprint,
      resolvedCommit: provenance.resolvedCommit
    }
  })
}

/** Publisher of an existing install from the same source, so reinstalling keeps its key. */
async function installedPublisherFor(
  pluginsDir: string,
  sameSource: (source: PluginLockEntry['source']) => boolean
): Promise<string | null> {
  const entries = Object.values((await readPluginLockfile(pluginsDir)).plugins)
  const entry = entries.find((candidate) => sameSource(candidate.source))
  return entry ? (splitQualifiedPluginKey(entry.pluginKey)?.publisher ?? null) : null
}

async function declaredPublisher(rootDir: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readPluginManifestText(rootDir))
    const publisher =
      typeof raw === 'object' && raw !== null && 'publisher' in raw ? raw.publisher : undefined
    return typeof publisher === 'string' ? publisher : undefined
  } catch {
    // Why undefined: staging reports the unreadable manifest with its real error.
    return undefined
  }
}
