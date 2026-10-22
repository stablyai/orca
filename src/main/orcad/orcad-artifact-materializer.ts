import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  ORCAD_MOBILE_WEB_DIR,
  ORCAD_MOBILE_WEB_MANIFEST,
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION_FILENAME,
  compareCodeUnits,
  isOrcadMobileWebAssetPath,
  orcadArtifactFilenames,
  orcadTemplateCommonFilenames,
  orcadTemplatePackagedRipgrep,
  orcadTemplateTargetFilenames
} from '../../shared/orcad-artifacts'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { findOrcadCachePath } from '../node-runtime/orcad-cache-path'
import type { PinnedRuntimeMaterializeOptions } from '../node-runtime/pinned-runtime-materializer'
import { readOrcadArtifactVerificationRecord } from './orcad-artifact-verification-record'
import {
  isCompleteArtifact,
  rememberVerification,
  sameHashes,
  signSlot,
  slotMatchesRecord,
  verifiedArtifactIdentity,
  type ArtifactSource,
  type ExpectedSha256
} from './orcad-artifact-source-verification'
import { OrcadTemplateManifestSchema, type OrcadTemplateManifest } from './orcad-template-manifest'
import { OrcadArtifactsUnavailableError, OrcadHostUnsupportedError } from './orcad-host-unavailable'

type MaterializeOptions = PinnedRuntimeMaterializeOptions & {
  templateDir?: string
  cacheRoot?: string
  /** WSL wake path only: reuse digests recorded by stat signature instead of re-hashing. */
  trustVerificationRecord?: boolean
}

const materializations = new Map<string, Promise<string>>()
// Slots handed out this session: a deploy may still be reading one, so cache retention keeps them.
const materializedVersions = new Set<string>()

export function materializedOrcadArtifactVersions(): ReadonlySet<string> {
  return materializedVersions
}

/** A verified slot directory for `target`; its runtime is referenced, not included (design D2). */
export async function materializeOrcadArtifact(
  target: NodeRuntimeTarget,
  options: MaterializeOptions = {}
): Promise<string> {
  options.signal?.throwIfAborted()
  const templateDir = options.templateDir ?? resolveOrcadTemplateDir()
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const trustVerificationRecord = options.trustVerificationRecord === true
  // Why the trust bit is keyed: an SSH or local caller must never join a record-trusting fill.
  const key = `${templateDir}\0${cacheRoot}\0${target}\0${trustVerificationRecord}`
  const existing = materializations.get(key)
  if (existing) {
    return waitForPromiseWithSignal(existing, options.signal)
  }
  // Cancellation detaches one caller; the bounded cache fill still serves other deployments.
  const pending = assembleOrcadArtifact({
    templateDir,
    cacheRoot,
    target,
    trustVerificationRecord
  }).finally(() => materializations.delete(key))
  materializations.set(key, pending)
  return waitForPromiseWithSignal(pending, options.signal)
}

export async function assembleOrcadArtifact(args: {
  templateDir: string
  cacheRoot: string
  target: NodeRuntimeTarget
  manifest?: OrcadTemplateManifest
  /** Test seam for deciding when a file's stat signature is old enough to trust. */
  now?: () => number
  /** Off (SSH, local serve): every launch hashes, and no record is read or written. */
  trustVerificationRecord?: boolean
}): Promise<string> {
  const trust = args.trustVerificationRecord === true
  const manifest = args.manifest ?? (await readTemplateManifest(args.templateDir))
  const mobileWebAssets = templateMobileWebAssets(manifest)
  const sources = artifactSources(args.templateDir, args.target, manifest, mobileWebAssets)
  const expected = expectedTemplateSha256(args.target, manifest, mobileWebAssets)
  const targetRoot = join(args.cacheRoot, args.target)
  const nowMs = (args.now ?? Date.now)()
  const record = trust ? await readOrcadArtifactVerificationRecord(targetRoot) : null
  const identity = await verifiedArtifactIdentity(sources, expected, record, nowMs, trust)
  await verifyTemplateMarkers(args.templateDir, args.target)
  const { fullVersion, sourceHashes } = identity
  const recordedSlot =
    record && record.contentDigest === identity.contentDigest && sameHashes(record, sourceHashes)
      ? record.slot
      : null
  let slotFromRecord = false
  const cached = await findOrcadCachePath(
    (attempt) => join(targetRoot, `${fullVersion}${attempt ? `.repair-${attempt}` : ''}`),
    async (path) => {
      slotFromRecord = await slotMatchesRecord(path, fullVersion, sources, recordedSlot, nowMs)
      return slotFromRecord || isCompleteArtifact(path, fullVersion, sources, sourceHashes)
    }
  )
  const targetDir = cached.path
  materializedVersions.add(fullVersion)
  if (cached.verified) {
    // Retention evicts by recency, so a reused slot counts as recently used.
    const now = new Date()
    await utimes(targetDir, now, now).catch(() => undefined)
    if (trust) {
      const slot = slotFromRecord ? recordedSlot : await signSlot(targetDir, sources, nowMs)
      await rememberVerification(targetRoot, record, identity, slot)
    }
    return targetDir
  }
  await mkdir(targetRoot, { recursive: true })
  const stagingDir = join(targetRoot, `.staging-${process.pid}-${randomUUID()}`)
  try {
    for (const source of sources) {
      const destination = join(stagingDir, source.filename)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source.path, destination)
      if (source.executable && !args.target.startsWith('win32-')) {
        await chmod(destination, 0o755)
      }
    }
    await writeFile(join(stagingDir, ORCAD_VERSION_FILENAME), `${fullVersion}\n`, { mode: 0o600 })
    if (!(await isCompleteArtifact(stagingDir, fullVersion, sources, sourceHashes))) {
      throw new Error('Orcad artifact sources changed while copying')
    }
    try {
      await rename(stagingDir, targetDir)
    } catch (error) {
      if (!(await isCompleteArtifact(targetDir, fullVersion, sources, sourceHashes))) {
        throw new Error(`Orcad artifact cache entry is unavailable or corrupted: ${targetDir}`, {
          cause: error
        })
      }
    }
    if (trust) {
      // Fresh copies are not settled yet, so the next launch hashes this slot once more.
      await rememberVerification(targetRoot, record, identity, null)
    }
    return targetDir
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

function isExecutableArtifact(filename: string): boolean {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function artifactSources(
  templateDir: string,
  target: NodeRuntimeTarget,
  manifest: OrcadTemplateManifest,
  mobileWebAssets: readonly string[]
): ArtifactSource[] {
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new OrcadHostUnsupportedError(`Packaged orcad template does not support ${target}`)
  }
  const packagedRipgrep = orcadTemplatePackagedRipgrep(
    manifest.schemaVersion,
    target,
    targetManifest.packagedRipgrep
  )
  const targetFiles = new Set(orcadTemplateTargetFilenames(target))
  const required = orcadArtifactFilenames(target, mobileWebAssets).map((filename) => ({
    filename,
    path: join(
      filename === packagedRipgrep
        ? dirname(templateDir)
        : targetFiles.has(filename)
          ? targetDir
          : templateDir,
      ...filename.split('/')
    ),
    executable: isExecutableArtifact(filename)
  }))
  if (!targetManifest.browserName) {
    return required
  }
  return [
    ...required,
    {
      filename: targetManifest.browserName,
      path: join(targetDir, targetManifest.browserName),
      executable: true
    }
  ]
}

/** The manifest digest each slot source must hash to. */
function expectedTemplateSha256(
  target: NodeRuntimeTarget,
  manifest: OrcadTemplateManifest,
  mobileWebAssets: readonly string[]
): Map<string, ExpectedSha256> {
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new OrcadHostUnsupportedError(`Packaged orcad template does not support ${target}`)
  }
  const expected = new Map<string, ExpectedSha256>()
  for (const filename of orcadTemplateCommonFilenames(mobileWebAssets)) {
    const sha256 = manifest.commonSha256[filename]
    if (!sha256) {
      throw new Error(`Packaged orcad template manifest omits ${filename}`)
    }
    expected.set(filename, { sha256, label: `orcad template ${filename}` })
  }
  for (const filename of orcadTemplateTargetFilenames(target)) {
    const sha256 = targetManifest.files[filename]
    if (!sha256) {
      throw new Error(`Packaged orcad template manifest omits ${target} ${filename}`)
    }
    expected.set(filename, { sha256, label: `${target} ${filename}` })
  }
  if (targetManifest.browserName && targetManifest.browserSha256) {
    // A browser named like a required file would replace that file's manifest digest.
    if (expected.has(targetManifest.browserName)) {
      throw new Error(`Packaged orcad template ${target} browser name collides with a slot file`)
    }
    expected.set(targetManifest.browserName, {
      sha256: targetManifest.browserSha256,
      label: `${target} browser`
    })
  }
  return expected
}

/**
 * The page's asset names, from the template manifest (verify-packaged-orcad-template.cjs pins them
 * to the page's own manifest), so a WSL wake that trusts its record reads no extra file.
 */
function templateMobileWebAssets(manifest: OrcadTemplateManifest): string[] {
  const prefix = `${ORCAD_MOBILE_WEB_DIR}/`
  const assets = Object.keys(manifest.commonSha256).filter(
    (filename) => filename.startsWith(prefix) && filename !== ORCAD_MOBILE_WEB_MANIFEST
  )
  // Names become copy destinations under the slot, so one escaping it must never be joined.
  const unsafe = assets.find(
    (filename) => !isOrcadMobileWebAssetPath(filename.slice(prefix.length))
  )
  if (unsafe) {
    throw new Error(`Packaged orcad template names an unsafe page asset: ${unsafe}`)
  }
  return assets.sort(compareCodeUnits)
}

async function readTemplateManifest(templateDir: string): Promise<OrcadTemplateManifest> {
  return OrcadTemplateManifestSchema.parse(
    JSON.parse(await readFile(join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME), 'utf8'))
  )
}

/** Content checks a manifest digest cannot express; both files are a few bytes. */
async function verifyTemplateMarkers(
  templateDir: string,
  target: NodeRuntimeTarget
): Promise<void> {
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  if ((await readFile(join(targetDir, ORCAD_SERVER_TARGET_FILENAME), 'utf8')).trim() !== target) {
    throw new Error(`Packaged orcad template target identity does not match ${target}`)
  }
  // Why against this client's pin: the slot must name the runtime this client will upload.
  const runtimeReference = await readFile(
    join(targetDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME),
    'utf8'
  )
  if (runtimeReference.trim() !== pinnedNodeRuntimeAsset(target).executableSha256) {
    throw new Error(`Packaged orcad template ${target} does not reference the pinned Node`)
  }
}

export function getOrcadTemplateCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.ORCA_ORCAD_TEMPLATE_PATH) {
    candidates.push(process.env.ORCA_ORCAD_TEMPLATE_PATH)
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'orcad-template'))
  }
  const appPath = getAppEnvironment().getAppPath()
  candidates.push(
    join(appPath, 'out', 'orcad-template'),
    join(appPath, 'resources', 'orcad-template')
  )
  return [...new Set(candidates)]
}

/** Whether this build carries an orcad template at all; dev builds usually don't. */
export function hasOrcadTemplate(): boolean {
  return getOrcadTemplateCandidates().some((candidate) => existsSync(candidate))
}

function resolveOrcadTemplateDir(): string {
  const found = getOrcadTemplateCandidates().find((candidate) => existsSync(candidate))
  if (!found) {
    throw new OrcadArtifactsUnavailableError('The packaged orcad deployment template is missing')
  }
  return found
}

export function resetOrcadArtifactMaterializationsForTests(): void {
  materializations.clear()
}
