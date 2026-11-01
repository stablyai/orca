import { existsSync } from 'node:fs'
import { cp, mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import {
  PLUGIN_MANIFEST_FILENAME,
  parseHostPluginManifest,
  qualifiedPluginKey,
  satisfiesOrcaEngineRange,
  type PluginManifest,
  type PluginManifestWithPublisher
} from '../../../shared/plugins/manifest/plugin-manifest'
import { withPluginPublisher } from '../../../shared/plugins/installation/plugin-publisher-derivation'
import { splitQualifiedPluginKey } from '../../../shared/plugins/catalog/plugin-marketplace'
import { pluginManifestCompatibilityError } from '../../../shared/plugins/manifest/plugin-manifest-compatibility'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import {
  pluginCatalogReleaseError,
  type PluginCatalogRelease
} from '../../../shared/plugins/catalog/plugin-catalog-release'
import type {
  PluginInstallSource,
  PluginLockEntry
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  validateDeclaredPluginArtifacts,
  validatePluginInstallContent,
  type PluginArtifactValidationResult
} from '../plugin-artifact-validation'
import { renamePluginFileWithWindowsRetry } from './plugin-atomic-file-write'
import { hashPluginTree } from '../plugin-content-hash'
import { publishPluginInstall } from './plugin-install-publication'
import { readPluginManifestText } from '../plugin-manifest-file'
import { pluginInstallTrustError } from './plugin-install-trust'

export type PluginInstallResult =
  | {
      ok: true
      pluginKey: string
      version: string
      contentHash: string
      consentFingerprint: string
      resolvedCommit: string | null
    }
  | { ok: false; error: string }

export type PluginInstallInspection =
  | {
      ok: true
      manifest: PluginManifestWithPublisher
      pluginKey: string
      contentHash: string
      consentFingerprint: string
    }
  | { ok: false; error: string }

async function validatePluginInstallTree(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const declared = await validateDeclaredPluginArtifacts(rootDir, manifest)
  return declared.ok ? validatePluginInstallContent(rootDir, manifest) : declared
}

async function readInstallManifest(
  rootDir: string,
  hostVersion: string
): Promise<{ ok: true; manifest: PluginManifest } | { ok: false; error: string }> {
  let raw: unknown
  try {
    raw = JSON.parse(await readPluginManifestText(rootDir))
  } catch (error) {
    return {
      ok: false,
      error: `unreadable ${PLUGIN_MANIFEST_FILENAME}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const parsed = parseHostPluginManifest(raw)
  if (!parsed.ok) {
    const incompatible = pluginManifestCompatibilityError(raw, hostVersion)
    return { ok: false, error: incompatible ?? `invalid manifest: ${parsed.error}` }
  }
  if (!satisfiesOrcaEngineRange(hostVersion, parsed.manifest.engines.orca)) {
    return {
      ok: false,
      error: `plugin requires Orca ${parsed.manifest.engines.orca} (this is ${hostVersion})`
    }
  }
  return { ok: true, manifest: parsed.manifest }
}

/** Who names the install: a listing's exact key, or a publisher derived from the source. */
export type PluginInstallIdentity = { pluginKey: string } | { publisher: string }

function identityPublisher(identity: PluginInstallIdentity): string {
  return 'pluginKey' in identity
    ? (splitQualifiedPluginKey(identity.pluginKey)?.publisher ?? '')
    : identity.publisher
}

/** Preview and install share tree verification so reviewed bytes obey install policy. */
export async function inspectPluginInstallTree(input: {
  rootDir: string
  hostVersion: string
  identity: PluginInstallIdentity
  /** Catalog-pinned release these bytes must match exactly. */
  release?: { record: PluginCatalogRelease; resolvedCommit: string | null }
}): Promise<PluginInstallInspection> {
  const sourceManifest = await readInstallManifest(input.rootDir, input.hostVersion)
  if (!sourceManifest.ok) {
    return sourceManifest
  }
  // Why the listing's publisher: catalogs derive it, so a manifest's own `publisher` is ignored.
  const manifest = withPluginPublisher(sourceManifest.manifest, identityPublisher(input.identity))
  const pluginKey = qualifiedPluginKey(manifest)
  if ('pluginKey' in input.identity && pluginKey !== input.identity.pluginKey) {
    return {
      ok: false,
      error: `plugin manifest id ${manifest.id} does not match marketplace listing ${input.identity.pluginKey}`
    }
  }
  const declaredArtifacts = await validatePluginInstallTree(input.rootDir, manifest)
  if (!declaredArtifacts.ok) {
    return { ok: false, error: `invalid declared artifact: ${declaredArtifacts.error}` }
  }
  const treeHash = await hashPluginTree(input.rootDir)
  if (!treeHash.ok) {
    return { ok: false, error: treeHash.error }
  }
  const releaseError =
    input.release &&
    pluginCatalogReleaseError({
      release: input.release.record,
      manifest,
      resolvedCommit: input.release.resolvedCommit,
      contentHash: treeHash.hash
    })
  if (releaseError) {
    return { ok: false, error: releaseError }
  }
  return {
    ok: true,
    manifest,
    pluginKey,
    contentHash: treeHash.hash,
    consentFingerprint: fingerprintPluginConsent(manifest, treeHash.hash)
  }
}

export async function installStagedPluginTree(input: {
  pluginsDir: string
  stagingDir: string
  hostVersion: string
  source: PluginInstallSource
  resolvedCommit: string | null
  identity: PluginInstallIdentity
  release?: PluginCatalogRelease
  /** Trusted bundled bytes may restore an immutable directory damaged on disk. */
  repairCorruptedVersion?: boolean
  blockedPluginReason?: (pluginKey: string) => string | null
  /** A refusal decided by the inspected manifest itself, e.g. full access being off. */
  manifestError?: (manifest: PluginManifest) => string | null
}): Promise<PluginInstallResult> {
  const sourceInspection = await inspectPluginInstallTree({
    rootDir: input.stagingDir,
    hostVersion: input.hostVersion,
    identity: input.identity,
    ...(input.release
      ? { release: { record: input.release, resolvedCommit: input.resolvedCommit } }
      : {})
  })
  if (!sourceInspection.ok) {
    return sourceInspection
  }
  const trustError = pluginInstallTrustError(sourceInspection.pluginKey, input.source)
  if (trustError) {
    return { ok: false, error: trustError }
  }
  const blockedReason = input.blockedPluginReason?.(sourceInspection.pluginKey)
  if (blockedReason) {
    return { ok: false, error: `plugin is blocked by Orca's safety list: ${blockedReason}` }
  }
  const manifestError = input.manifestError?.(sourceInspection.manifest)
  if (manifestError) {
    return { ok: false, error: manifestError }
  }
  let manifest = sourceInspection.manifest
  const pluginKey = sourceInspection.pluginKey
  const pluginDir = join(input.pluginsDir, pluginKey)
  const versionDir = join(pluginDir, sourceInspection.contentHash)
  if (existsSync(versionDir) && input.repairCorruptedVersion) {
    const existingHash = await hashPluginTree(versionDir)
    if (!existingHash.ok || existingHash.hash !== sourceInspection.contentHash) {
      // Release-index-verified bundled bytes can repair damaged immutable installs.
      await rm(versionDir, { recursive: true, force: true })
    }
  }
  if (!existsSync(versionDir)) {
    const stagedVersionDir = `${versionDir}.staging`
    try {
      await rm(stagedVersionDir, { recursive: true, force: true })
      await mkdir(pluginDir, { recursive: true })
      // Rehash the copy before publication because the source may change during copying.
      const stagingRoot = resolve(input.stagingDir)
      await cp(stagingRoot, stagedVersionDir, {
        recursive: true,
        verbatimSymlinks: true,
        // Exclude source-control metadata before copying so repository size cannot bypass install limits.
        filter: (source) => {
          const fromRoot = relative(stagingRoot, resolve(source))
          return fromRoot !== '.git' && !fromRoot.startsWith(`.git${sep}`)
        }
      })
      const copiedHash = await hashPluginTree(stagedVersionDir)
      if (!copiedHash.ok || copiedHash.hash !== sourceInspection.contentHash) {
        return {
          ok: false,
          error: copiedHash.ok
            ? 'plugin content changed while it was being copied'
            : copiedHash.error
        }
      }
      const copiedManifest = await readInstallManifest(stagedVersionDir, input.hostVersion)
      if (!copiedManifest.ok) {
        return { ok: false, error: `copied ${copiedManifest.error}` }
      }
      if (copiedManifest.manifest.id !== manifest.id) {
        return { ok: false, error: 'plugin manifest identity changed while it was being staged' }
      }
      manifest = withPluginPublisher(copiedManifest.manifest, manifest.publisher)
      const copiedArtifacts = await validatePluginInstallTree(stagedVersionDir, manifest)
      if (!copiedArtifacts.ok) {
        return { ok: false, error: `copied artifact validation failed: ${copiedArtifacts.error}` }
      }
      await renamePluginFileWithWindowsRetry(stagedVersionDir, versionDir)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(stagedVersionDir, { recursive: true, force: true })
    }
  } else {
    // Reverify existing hash directories before repointing; partial/tampered installs must not revive.
    const existingHash = await hashPluginTree(versionDir)
    if (!existingHash.ok || existingHash.hash !== sourceInspection.contentHash) {
      return {
        ok: false,
        error: existingHash.ok
          ? 'existing plugin content failed integrity verification'
          : existingHash.error
      }
    }
    const existingManifest = await readInstallManifest(versionDir, input.hostVersion)
    if (!existingManifest.ok) {
      return { ok: false, error: `installed ${existingManifest.error}` }
    }
    if (existingManifest.manifest.id !== manifest.id) {
      return { ok: false, error: 'installed plugin manifest identity does not match its directory' }
    }
    manifest = withPluginPublisher(existingManifest.manifest, manifest.publisher)
    const existingArtifacts = await validatePluginInstallTree(versionDir, manifest)
    if (!existingArtifacts.ok) {
      return {
        ok: false,
        error: `installed artifact validation failed: ${existingArtifacts.error}`
      }
    }
  }
  const consentFingerprint = fingerprintPluginConsent(manifest, sourceInspection.contentHash)
  const entry: PluginLockEntry = {
    pluginKey,
    version: manifest.version,
    source: input.source,
    resolvedCommit: input.resolvedCommit,
    contentHash: sourceInspection.contentHash,
    consentFingerprint,
    installedAt: Date.now()
  }
  try {
    await publishPluginInstall({ pluginsDir: input.pluginsDir, pluginDir, entry })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    pluginKey,
    version: manifest.version,
    contentHash: sourceInspection.contentHash,
    consentFingerprint,
    resolvedCommit: input.resolvedCommit
  }
}
