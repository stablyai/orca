import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  hashPluginTree,
  validateDeclaredPluginArtifacts,
  validatePluginInstallContent
} from '../../main/plugins/plugin-authoring-checks'
import { PLUGIN_CATALOG_FILENAME } from '../../shared/plugins/catalog/plugin-catalog'
import {
  pluginApprovalGrants,
  pluginNeedsCliApproval,
  type PluginApprovalGrants
} from '../../shared/plugins/approval/plugin-cli-approval'
import { strictPluginArtifactErrors } from '../../shared/plugins/authoring/plugin-strict-artifact-checks'
import { validatePluginFile } from '../../shared/plugins/installation/plugin-file-validation'
import {
  localPluginPublisher,
  withPluginPublisher
} from '../../shared/plugins/installation/plugin-publisher-derivation'
import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  qualifiedPluginKey,
  type PluginManifest
} from '../../shared/plugins/manifest/plugin-manifest'

export type PluginFolderSummary = {
  pluginKey: string
  name: string
  version: string
  /** Whether loading or enabling it needs `--approve`; content-only plugins never do. */
  needsApproval: boolean
  grants: PluginApprovalGrants
}

export type PluginValidationReport = {
  path: string
  file: string
  kind: 'plugin' | 'catalog'
  valid: boolean
  errors: string[]
  plugin?: PluginFolderSummary
}

function manifestTextReader(root: string) {
  return (manifestPath: string): string | null => {
    const file = join(root, ...manifestPath.split('/'))
    return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : null
  }
}

// Why contained: a catalog image path must stay inside the catalog repository.
function catalogFileReader(root: string) {
  return (relative: string) => {
    const target = resolve(root, relative)
    if (!target.startsWith(`${resolve(root)}${sep}`) || !existsSync(target)) {
      return null
    }
    const bytes = readFileSync(target)
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
}

function resolveTargetFile(target: string): string {
  if (!existsSync(target)) {
    throw new Error(`${target} does not exist`)
  }
  if (!statSync(target).isDirectory()) {
    return target
  }
  const found = [PLUGIN_MANIFEST_FILENAME, PLUGIN_CATALOG_FILENAME]
    .map((name) => join(target, name))
    .find((file) => existsSync(file))
  if (!found) {
    throw new Error(`${target} has no ${PLUGIN_MANIFEST_FILENAME} or ${PLUGIN_CATALOG_FILENAME}`)
  }
  return found
}

async function contentErrors(root: string, manifest: PluginManifest): Promise<string[]> {
  const errors = strictPluginArtifactErrors(manifest, manifestTextReader(root))
  for (const check of [validateDeclaredPluginArtifacts, validatePluginInstallContent]) {
    const result = await check(root, manifest)
    if (!result.ok) {
      errors.push(result.error)
    }
  }
  return errors
}

/** The checks `pnpm validate:plugin` runs, plus every file Orca reads at load. Offline; never runs plugin code. */
export async function validatePluginTarget(target: string): Promise<PluginValidationReport> {
  const file = resolveTargetFile(target)
  const root = dirname(file)
  const name = basename(file)
  const kind = name === PLUGIN_CATALOG_FILENAME ? 'catalog' : 'plugin'
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { path: root, file, kind, valid: false, errors: [`invalid JSON: ${detail}`] }
  }
  const errors = validatePluginFile(name, raw, catalogFileReader(root))
  const parsed = kind === 'plugin' && errors.length === 0 ? parsePluginManifest(raw) : null
  if (!parsed?.ok) {
    return { path: root, file, kind, valid: errors.length === 0, errors }
  }
  const { manifest } = parsed
  errors.push(...(await contentErrors(root, manifest)))
  return {
    path: root,
    file,
    kind,
    valid: errors.length === 0,
    errors,
    plugin: {
      // Why derived: a folder loads under its declared publisher, else `local`, like dev discovery.
      pluginKey: qualifiedPluginKey(
        withPluginPublisher(manifest, localPluginPublisher(manifest.publisher))
      ),
      name: manifest.name,
      version: manifest.version,
      needsApproval: pluginNeedsCliApproval(manifest),
      grants: pluginApprovalGrants(manifest)
    }
  }
}

export type PluginInspection = PluginValidationReport & {
  /** What `orca plugin install` of these exact files would record; absent when unhashable. */
  contentHash?: string
  fileCount?: number
  totalBytes?: number
}

export async function inspectPluginFolder(target: string): Promise<PluginInspection> {
  const report = await validatePluginTarget(target)
  if (report.kind !== 'plugin') {
    return report
  }
  const hashed = await hashPluginTree(report.path)
  return hashed.ok
    ? {
        ...report,
        contentHash: hashed.hash,
        fileCount: hashed.fileCount,
        totalBytes: hashed.totalBytes
      }
    : { ...report, valid: false, errors: [...report.errors, hashed.error] }
}
