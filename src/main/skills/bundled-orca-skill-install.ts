import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BUNDLED_ORCA_SKILL_PACKAGES,
  type BundledOrcaSkillPackage
} from './bundled-orca-skill-packages'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest,
  type SkillPackageFile,
  type SkillPackageManifestV1
} from '../../shared/skill-package-manifest'
import { isOrcaSkillLockSource } from '../../shared/skill-freshness'
import {
  installSharedExtractedSkill,
  skillInstallLocalTarget,
  type SkillInstallTargetInput
} from './skill-install-service'
import type { LocalSkillInstallTarget } from './skill-install-transaction'
import {
  BUNDLED_ORCA_SKILL_PACKAGE_ID_PREFIX,
  readSkillInstallReceipt,
  type SkillInstallReceiptV1
} from './skill-install-provenance'
import {
  beginSkillExtractionRecovery,
  finishSkillExtractionRecovery
} from './skill-extraction-recovery'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { skillInstallFailureFromError } from './skill-install-operation-error'
import { readProjectSkillLockSources, readSkillLockSources } from './skill-lock-sources'

export function findBundledOrcaSkillPackage(name: string): BundledOrcaSkillPackage | null {
  return BUNDLED_ORCA_SKILL_PACKAGES.find((entry) => entry.name === name) ?? null
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function bundledOrcaSkillManifest(entry: BundledOrcaSkillPackage): SkillPackageManifestV1 {
  // Why text identity equals the exact hash: the generator stores every file LF-normalized.
  const files: SkillPackageFile[] = entry.files.map((file) => {
    const bytes = Buffer.from(file.text, 'utf8')
    const digest = sha256(bytes)
    return {
      path: file.path,
      size: bytes.length,
      executable: false,
      classification: 'text',
      sha256: digest,
      identitySha256: digest
    }
  })
  const packageDigest = computeSkillPackageDigest(files)
  return parseSkillPackageManifest({
    schemaVersion: 1,
    packageId: `${BUNDLED_ORCA_SKILL_PACKAGE_ID_PREFIX}${entry.name}`,
    versionId: packageDigest,
    name: entry.name,
    description: '',
    createdAt: new Date(0).toISOString(),
    files,
    packageDigest
  })
}

export type BundledOrcaSkillInstallInput = Omit<
  SkillInstallTargetInput,
  'operationId' | 'adoptableDigests' | 'conflictResolution' | 'expectedPackageDigest'
> & {
  /** Replaces copies with local changes too; never a link or a colliding name. */
  discardLocalChanges?: boolean
  /** The skills.sh lock at this scope. Read only: Orca never writes it. */
  readLockSources?: () => Promise<ReadonlyMap<string, string>>
}

export type BundledInstallContext = {
  target: Omit<SkillInstallTargetInput, 'operationId'>
  lockSources: ReadonlyMap<string, string>
}

export async function bundledInstallContext(
  input: BundledOrcaSkillInstallInput
): Promise<BundledInstallContext> {
  const { discardLocalChanges, readLockSources, ...target } = input
  const lockSources = await (
    readLockSources ??
    (() =>
      input.scope === 'workspace' && input.workspaceDirectory
        ? readProjectSkillLockSources(input.workspaceDirectory)
        : readSkillLockSources())
  )()
  return {
    target: {
      ...target,
      ...(discardLocalChanges ? { conflictResolution: 'replace-and-discard-local' as const } : {})
    },
    lockSources
  }
}

export type PreparedBundledSkill = {
  entry: BundledOrcaSkillPackage
  manifest: SkillPackageManifestV1
  canonicalPath: string
  receipt: SkillInstallReceiptV1 | null
  request: SkillInstallTargetInput
  local: LocalSkillInstallTarget
}

/**
 * An earlier Orca version is ours to replace when the skills.sh lock or Orca's own receipt
 * says Orca installed it. Any other bytes are the user's and stay a conflict.
 */
export async function prepareBundledSkill(
  context: BundledInstallContext,
  entry: BundledOrcaSkillPackage
): Promise<PreparedBundledSkill> {
  const manifest = bundledOrcaSkillManifest(entry)
  const base: SkillInstallTargetInput = {
    ...context.target,
    operationId: randomUUID(),
    expectedPackageDigest: manifest.packageDigest
  }
  const resolved = skillInstallLocalTarget(base)
  const canonicalPath = join(resolved.destinationRoot, entry.name)
  const receipt = await readSkillInstallReceipt(resolved.stateDirectory, canonicalPath)
  const owned =
    isOrcaSkillLockSource(context.lockSources.get(entry.name) ?? null) ||
    Boolean(receipt?.packageId.startsWith(BUNDLED_ORCA_SKILL_PACKAGE_ID_PREFIX))
  const adoptableDigests = owned ? entry.releasedDigests : undefined
  // Why: the placement transaction unlinks any receipt provider it is not given, so a
  // narrower --agent or a missed detection would remove the skill from an agent that has it.
  const detectedProviders = [...new Set([...base.detectedProviders, ...(receipt?.providers ?? [])])]
  return {
    entry,
    manifest,
    canonicalPath,
    receipt,
    request: { ...base, detectedProviders, adoptableDigests },
    local: { ...resolved, adoptableDigests }
  }
}

async function installBundledSkill(prepared: PreparedBundledSkill): Promise<SkillInstallResult> {
  const { entry, manifest, request, local } = prepared
  const filesystem = request.filesystem ?? nativeSkillInstallFilesystem
  await mkdir(local.destinationRoot, { recursive: true })
  const recovery = await beginSkillExtractionRecovery(
    local.stateDirectory,
    local.destinationRoot,
    request.wslDistro
  )
  try {
    const skillRoot = join(recovery.extractionPath, 'skill')
    for (const file of entry.files) {
      const target = join(skillRoot, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.text, 'utf8')
    }
    await request.filesystem?.prepareExtractedSkill(skillRoot, manifest)
    return await installSharedExtractedSkill(request, {
      extractionPath: recovery.extractionPath,
      manifest
    })
  } finally {
    await finishSkillExtractionRecovery(local.stateDirectory, recovery, filesystem)
  }
}

function failedResult(entry: BundledOrcaSkillPackage, error: unknown): SkillInstallResult {
  const failure = skillInstallFailureFromError(error)
  const code = failure?.code ?? 'skill-install-bundled-failed'
  return {
    operationId: randomUUID(),
    status: failure?.category === 'cancelled' ? 'cancelled' : 'failed',
    name: entry.name,
    packageDigest: bundledOrcaSkillManifest(entry).packageDigest,
    placements: [],
    errorCategory: code,
    failure: failure ?? { category: 'filesystem', code, retryable: true }
  }
}

export function requireBundledPackages(names: readonly string[]): BundledOrcaSkillPackage[] {
  return names.map((name) => {
    const entry = findBundledOrcaSkillPackage(name)
    if (!entry) {
      throw new Error(`skill-install-bundled-unknown:${name}`)
    }
    return entry
  })
}

/** Installs or updates Orca's own skills from the bytes this build ships. */
export async function installBundledOrcaSkills(
  names: readonly string[],
  input: BundledOrcaSkillInstallInput
): Promise<SkillInstallResult[]> {
  const entries = requireBundledPackages(names)
  const context = await bundledInstallContext(input)
  const results: SkillInstallResult[] = []
  // Why sequential: each skill takes its own transaction lock, and one failure must not
  // abandon the rest.
  for (const entry of entries) {
    results.push(
      await prepareBundledSkill(context, entry)
        .then(installBundledSkill)
        .catch((error) => failedResult(entry, error))
    )
  }
  return results
}
