import type { SkillInstallResult } from '../../shared/skill-install-contract'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'
import { skillInstallFailureFromError } from './skill-install-operation-error'
import type { SkillCanonicalState } from './skill-install-planner'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import type { LocalSkillInstallInput } from './skill-install-transaction'

export function skillInstallConflictResult(
  operationId: string,
  manifest: SkillPackageManifestV1,
  state: SkillCanonicalState,
  code = `skill-install-conflict-${state.kind}`
): SkillInstallResult {
  const kind =
    state.kind === 'modified' ||
    state.kind === 'unowned' ||
    state.kind === 'external-link' ||
    state.kind === 'name-collision'
      ? state.kind
      : 'modified'
  return {
    operationId,
    status: 'conflict',
    name: manifest.name,
    packageDigest: manifest.packageDigest,
    placements: [],
    conflict: {
      kind,
      ...('digest' in state && state.digest ? { existingDigest: state.digest } : {})
    },
    errorCategory: code,
    failure: { category: 'conflict', code, retryable: false }
  }
}

export function skillInstallFailureResult(
  input: LocalSkillInstallInput,
  manifest: SkillPackageManifestV1,
  canonicalPath: string,
  error: unknown
): SkillInstallResult | null {
  const failure = skillInstallFailureFromError(error)
  if (!failure || !['filesystem', 'recovery', 'cancelled'].includes(failure.category)) {
    return null
  }
  return {
    operationId: input.operationId,
    status: failure.category === 'cancelled' ? 'cancelled' : 'failed',
    name: manifest.name,
    packageDigest: manifest.packageDigest,
    canonicalPath,
    placements: [],
    errorCategory: failure.code,
    failure
  }
}

export function skillInstallReplacementAllowed(
  state: SkillCanonicalState,
  input: LocalSkillInstallInput
): boolean {
  if (state.kind === 'missing' || state.kind === 'clean-update') {
    return input.conflictResolution !== 'cancel'
  }
  return (
    (state.kind === 'modified' || state.kind === 'unowned') &&
    input.conflictResolution === 'replace-and-discard-local'
  )
}

export function skillInstallUnchangedResult(
  input: LocalSkillInstallInput,
  manifest: SkillPackageManifestV1,
  canonicalPath: string,
  receipt: SkillInstallReceiptV1
): SkillInstallResult {
  return {
    operationId: input.operationId,
    status: 'unchanged',
    name: manifest.name,
    packageDigest: manifest.packageDigest,
    canonicalPath,
    placements: receipt.placements.map((placement) =>
      placement.status === 'installed' ? { ...placement, status: 'unchanged' } : placement
    )
  }
}

export function createSkillInstallReceipt(input: {
  request: LocalSkillInstallInput
  manifest: SkillPackageManifestV1
  archiveSha256: string
  canonicalPath: string
  previous: SkillInstallReceiptV1 | null
}): SkillInstallReceiptV1 {
  return {
    schemaVersion: 1,
    packageId: input.manifest.packageId,
    versionId: input.manifest.versionId,
    packageDigest: input.manifest.packageDigest,
    ...(input.request.sourceBundleDigest ? { bundleDigest: input.request.sourceBundleDigest } : {}),
    archiveSha256: input.archiveSha256,
    scope: input.request.scope,
    destinationIdentity: input.request.destinationIdentity,
    canonicalPath: input.canonicalPath,
    placements: [
      {
        provider: 'agent-skills',
        path: input.canonicalPath,
        topology: 'canonical-copy',
        status: 'installed'
      }
    ],
    ...(input.previous ? { previousVersionId: input.previous.versionId } : {}),
    installedAt: new Date().toISOString(),
    hostIdentity: input.request.hostIdentity,
    fileModes: input.manifest.files.map((file) => ({
      path: file.path,
      executable: file.executable
    })),
    ...(input.request.wslDistro ? { wslDistro: input.request.wslDistro } : {})
  }
}
