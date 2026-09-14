import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SkillBundleInstallProgress,
  SkillBundleInstallResult,
  SkillBundleSkillResult
} from '../../shared/skill-bundle-install-contract'
import { SkillBundleInstallResultSchema } from '../../shared/skill-bundle-install-contract'
import type { SkillBundleEntry } from '../../shared/skill-bundle-manifest'
import { parseSkillPackageManifest } from '../../shared/skill-package-manifest'
import { extractSkillBundleArchive } from './skill-bundle-extraction'
import {
  installSharedExtractedSkill,
  skillInstallLocalInput,
  type SkillInstallServiceInput
} from './skill-install-service'
import {
  previewLocalExtractedSkillPackage,
  type LocalExtractedSkillPackage
} from './skill-install-transaction'
import { skillInstallFailureFromError } from './skill-install-operation-error'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'
import {
  beginSkillExtractionRecovery,
  finishSkillExtractionRecovery
} from './skill-extraction-recovery'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'

export type SkillBundleInstallServiceInput = Omit<
  SkillInstallServiceInput,
  'expectedPackageDigest' | 'expectedPackageId' | 'expectedVersionId' | 'conflictResolution'
> & {
  packageId: string
  versionId: string
  bundleDigest: string
  selectedSkillIds: readonly string[]
  conflictDecisions?: ReadonlyMap<
    string,
    'keep-local' | 'replace-unmodified' | 'replace-and-discard-local'
  >
  onProgress?: (progress: SkillBundleInstallProgress) => void
}

function skillManifest(input: {
  packageId: string
  versionId: string
  createdAt: string
  skill: SkillBundleEntry
}) {
  return parseSkillPackageManifest({
    schemaVersion: 1,
    packageId: input.packageId,
    versionId: input.versionId,
    name: input.skill.name,
    description: input.skill.description,
    createdAt: input.createdAt,
    files: input.skill.files,
    packageDigest: input.skill.digest
  })
}

function conflictResult(
  skill: SkillBundleEntry,
  preview: Awaited<ReturnType<typeof previewLocalExtractedSkillPackage>>
): SkillBundleSkillResult {
  const state = preview.currentState
  const kind =
    state.kind === 'modified' ||
    state.kind === 'unowned' ||
    state.kind === 'external-link' ||
    state.kind === 'name-collision'
      ? state.kind
      : 'modified'
  return {
    skillId: skill.id,
    name: skill.name,
    digest: skill.digest,
    status: 'kept-local',
    placements: [],
    conflict: {
      kind,
      ...('digest' in state && state.digest ? { existingDigest: state.digest } : {})
    }
  }
}

function completedSkillResult(input: {
  skill: SkillBundleEntry
  preview: Awaited<ReturnType<typeof previewLocalExtractedSkillPackage>>
  result: Awaited<ReturnType<typeof installSharedExtractedSkill>>
}): SkillBundleSkillResult {
  const status =
    input.result.status === 'partial'
      ? input.preview.currentState.kind === 'missing'
        ? 'installed'
        : input.preview.currentState.kind === 'unchanged'
          ? 'unchanged'
          : 'updated'
      : input.result.status === 'conflict'
        ? 'kept-local'
        : input.result.status === 'cancelled'
          ? 'cancelled'
          : input.result.status === 'failed'
            ? 'failed'
            : input.result.status === 'removed'
              ? 'failed'
              : input.result.status
  return {
    skillId: input.skill.id,
    name: input.skill.name,
    digest: input.skill.digest,
    status,
    ...(input.result.canonicalPath ? { canonicalPath: input.result.canonicalPath } : {}),
    placements: input.result.placements
      .filter((placement) => placement.status !== 'removed')
      .map((placement) => ({
        ...placement,
        status: placement.status === 'removed' ? 'skipped' : placement.status
      })),
    ...(input.result.conflict ? { conflict: input.result.conflict } : {}),
    ...(input.result.errorCategory ? { errorCategory: input.result.errorCategory } : {}),
    ...(input.result.failure ? { failure: input.result.failure } : {})
  }
}

function bundleStatus(
  skills: readonly SkillBundleSkillResult[]
): SkillBundleInstallResult['status'] {
  if (skills.every((skill) => skill.status === 'cancelled')) {
    return 'cancelled'
  }
  if (skills.every((skill) => skill.status === 'failed')) {
    return 'failed'
  }
  return skills.some(
    (skill) =>
      ['kept-local', 'failed', 'cancelled'].includes(skill.status) ||
      skill.placements.some(
        (placement) => placement.status === 'failed' || placement.status === 'skipped'
      )
  )
    ? 'partial'
    : 'complete'
}

export async function installSkillBundle(
  input: SkillBundleInstallServiceInput
): Promise<SkillBundleInstallResult> {
  const destinationRoot = skillInstallLocalInput({
    ...input,
    expectedPackageDigest: input.bundleDigest,
    expectedPackageId: input.packageId,
    expectedVersionId: input.versionId
  }).destinationRoot
  await mkdir(destinationRoot, { recursive: true })
  const stateDirectory = join(input.orcaStateDirectory, 'skill-installs')
  const recovery = await beginSkillExtractionRecovery(
    stateDirectory,
    destinationRoot,
    input.wslDistro
  )
  const extractionPath = recovery.extractionPath
  try {
    const extracted = await extractSkillBundleArchive({
      archivePath: input.archivePath,
      destinationDirectory: extractionPath,
      expectedArchiveSha256: input.expectedArchiveSha256,
      expectedBundleDigest: input.bundleDigest,
      expectedPackageId: input.packageId,
      expectedVersionId: input.versionId,
      signal: input.signal
    })
    const selected = new Set(input.selectedSkillIds)
    const skills = extracted.manifest.skills.filter((skill) => selected.has(skill.id))
    if (skills.length !== selected.size) {
      throw new Error('skill-bundle-selection-invalid')
    }
    const results: SkillBundleSkillResult[] = []
    for (const [index, skill] of skills.entries()) {
      try {
        input.onProgress?.({
          operationId: input.operationId,
          skillId: skill.id,
          skillName: skill.name,
          skillIndex: index + 1,
          skillCount: skills.length
        })
      } catch {
        // Why: progress observers cannot participate in the install transaction.
      }
      if (input.signal?.aborted) {
        results.push({
          skillId: skill.id,
          name: skill.name,
          digest: skill.digest,
          status: 'cancelled',
          placements: []
        })
        continue
      }
      const manifest = skillManifest({
        packageId: extracted.manifest.packageId,
        versionId: extracted.manifest.versionId,
        createdAt: extracted.manifest.createdAt,
        skill
      })
      const wrapper = join(extractionPath, 'selected', skill.id)
      const extractedSkill: LocalExtractedSkillPackage = {
        extractionPath: wrapper,
        manifest,
        archiveSha256: extracted.archiveSha256
      }
      const decision = input.conflictDecisions?.get(skill.id)
      const serviceInput: SkillInstallServiceInput = {
        ...input,
        expectedPackageDigest: skill.digest,
        expectedPackageId: extracted.manifest.packageId,
        expectedVersionId: extracted.manifest.versionId,
        sourceBundleDigest: extracted.manifest.bundleDigest,
        conflictResolution: decision === 'keep-local' ? undefined : decision
      }
      const localInput = skillInstallLocalInput(serviceInput)
      const preview = await previewLocalExtractedSkillPackage(localInput, extractedSkill)
      const isConflict = !['missing', 'unchanged', 'clean-update'].includes(
        preview.currentState.kind
      )
      if (isConflict && decision !== 'replace-and-discard-local') {
        results.push(conflictResult(skill, preview))
        continue
      }
      await mkdir(wrapper, { recursive: true, mode: 0o700 })
      const source = join(extracted.skillsDirectory, skill.name)
      const target = join(wrapper, 'skill')
      await (input.filesystem
        ? input.filesystem.rename(source, target)
        : renameSkillPathWithWindowsRetry(source, target))
      try {
        await input.filesystem?.prepareExtractedSkill(target, manifest)
        const result = await installSharedExtractedSkill(serviceInput, extractedSkill)
        results.push(completedSkillResult({ skill, preview, result }))
      } catch (error) {
        const failure = skillInstallFailureFromError(error)
        results.push({
          skillId: skill.id,
          name: skill.name,
          digest: skill.digest,
          status: failure?.category === 'cancelled' ? 'cancelled' : 'failed',
          placements: [],
          ...(failure ? { errorCategory: failure.code, failure } : {})
        })
      }
    }
    return SkillBundleInstallResultSchema.parse({
      operationId: input.operationId,
      packageId: extracted.manifest.packageId,
      versionId: extracted.manifest.versionId,
      bundleDigest: extracted.manifest.bundleDigest,
      status: bundleStatus(results),
      skills: results
    })
  } finally {
    await finishSkillExtractionRecovery(
      stateDirectory,
      recovery,
      input.filesystem ?? nativeSkillInstallFilesystem
    )
  }
}
