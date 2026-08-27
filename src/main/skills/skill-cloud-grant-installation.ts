import { app } from 'electron'
import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_INSTALL_CAPABILITY,
  SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE
} from '../../shared/skill-install-capability'
import type {
  SkillBundleInstallProgress,
  SkillBundleInstallRequest,
  SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import type {
  SkillInstallDestination,
  SkillInstallRequest
} from '../../shared/skill-install-contract'
import type { SkillCloudDownloadGrant } from '../../shared/skill-cloud-contract'
import { getRuntimeEnvironmentStatus } from '../ipc/runtime-environment-transport-routing'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { skillInstallFailureFromError } from './skill-install-operation-error'
import { recordSkillCapabilityAbsence } from './skill-operation-observability'
import {
  installSkillBundleOnRemoteRuntime,
  installSkillOnRemoteRuntime
} from './skill-remote-install-service'

export type SkillCloudGrantInstallInput = {
  operationId: string
  environmentId?: string
  destination: SkillInstallDestination
  providers?: string[]
  conflictResolution?: 'replace-unmodified' | 'replace-and-discard-local' | 'cancel'
}

export type SkillBundleCloudGrantInstallInput = {
  operationId: string
  environmentId?: string
  selectedSkillIds: string[]
  destination: SkillInstallDestination
  providers?: string[]
  conflictDecisions?: SkillBundleInstallRequest['conflictDecisions']
}

function bundleFailureResult(
  grant: SkillCloudDownloadGrant,
  request: SkillBundleInstallRequest,
  failure: NonNullable<ReturnType<typeof skillInstallFailureFromError>>
): SkillBundleInstallResult {
  const manifest = grant.version.manifest
  if (!('skills' in manifest)) {
    throw new Error('skill-bundle-cloud-manifest-required')
  }
  return {
    operationId: request.operationId,
    packageId: request.package.packageId,
    versionId: request.package.versionId,
    bundleDigest: request.package.bundleDigest,
    status: failure.category === 'cancelled' ? 'cancelled' : 'failed',
    skills: manifest.skills
      .filter((skill) => request.selectedSkillIds.includes(skill.id))
      .map((skill) => ({
        skillId: skill.id,
        name: skill.name,
        digest: skill.digest,
        status: failure.category === 'cancelled' ? ('cancelled' as const) : ('failed' as const),
        placements: [],
        errorCategory: failure.code,
        failure
      }))
  }
}

export async function installSkillBundleCloudGrant(
  runtime: OrcaRuntimeService,
  grant: SkillCloudDownloadGrant,
  input: SkillBundleCloudGrantInstallInput,
  signal?: AbortSignal,
  onProgress?: (progress: SkillBundleInstallProgress) => void
) {
  const manifest = grant.version.manifest
  if (!('skills' in manifest)) {
    throw new Error('skill-bundle-cloud-manifest-required')
  }
  const request: SkillBundleInstallRequest = {
    operationId: input.operationId,
    package: {
      packageId: grant.version.packageId,
      versionId: grant.version.versionId,
      bundleDigest: manifest.bundleDigest,
      archiveSha256: grant.version.archiveSha256,
      compressedBytes: grant.version.compressedBytes
    },
    selectedSkillIds: input.selectedSkillIds,
    ingress: { kind: 'download-grant', ...grant.grant },
    destination: input.destination,
    ...(input.providers ? { providers: input.providers } : {}),
    conflictDecisions: input.conflictDecisions ?? []
  }
  try {
    if (!input.environmentId) {
      return {
        status: 'ok' as const,
        value: await runtime.installSharedSkillBundleRequest(request, undefined, onProgress)
      }
    }
    const userDataPath = app.getPath('userData')
    const status = await getRuntimeEnvironmentStatus(userDataPath, input.environmentId, 15_000)
    if (
      status.ok !== true ||
      status.result.capabilities?.includes(SKILL_BUNDLE_INSTALL_CAPABILITY) !== true
    ) {
      if (status.ok === true) {
        recordSkillCapabilityAbsence({
          capability: SKILL_BUNDLE_INSTALL_CAPABILITY,
          destination: 'remote-runtime'
        })
      }
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    return {
      status: 'ok' as const,
      value: await installSkillBundleOnRemoteRuntime({
        userDataPath,
        environmentId: input.environmentId,
        request,
        capabilities: status.result.capabilities ?? [],
        requireHttps: app.isPackaged,
        signal,
        onProgress
      })
    }
  } catch (error) {
    const failure = skillInstallFailureFromError(error)
    if (failure?.category === 'compatibility') {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    if (!failure) {
      throw error
    }
    return { status: 'ok' as const, value: bundleFailureResult(grant, request, failure) }
  }
}

export async function installSkillCloudGrant(
  runtime: OrcaRuntimeService,
  grant: SkillCloudDownloadGrant,
  input: SkillCloudGrantInstallInput,
  signal?: AbortSignal
) {
  const request: SkillInstallRequest = {
    operationId: input.operationId,
    package: {
      packageId: grant.version.packageId,
      versionId: grant.version.versionId,
      packageDigest: grant.version.packageDigest,
      archiveSha256: grant.version.archiveSha256,
      compressedBytes: grant.version.compressedBytes
    },
    ingress: {
      kind: 'download-grant',
      url: grant.grant.url,
      expiresAt: grant.grant.expiresAt
    },
    destination: input.destination,
    ...(input.providers ? { providers: input.providers } : {}),
    conflictResolution: input.conflictResolution
  }
  try {
    if (!input.environmentId) {
      return { status: 'ok' as const, value: await runtime.installSharedSkillRequest(request) }
    }
    const userDataPath = app.getPath('userData')
    const status = await getRuntimeEnvironmentStatus(userDataPath, input.environmentId, 15_000)
    if (
      status.ok !== true ||
      status.result.capabilities?.includes(SKILL_INSTALL_CAPABILITY) !== true
    ) {
      if (status.ok === true) {
        recordSkillCapabilityAbsence({
          capability: SKILL_INSTALL_CAPABILITY,
          destination: 'remote-runtime'
        })
      }
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    return {
      status: 'ok' as const,
      value: await installSkillOnRemoteRuntime({
        userDataPath,
        environmentId: input.environmentId,
        request,
        capabilities: status.result.capabilities ?? [],
        requireHttps: app.isPackaged,
        signal
      })
    }
  } catch (error) {
    const failure = skillInstallFailureFromError(error)
    if (failure?.category === 'compatibility') {
      return { status: 'unsupported' as const, message: SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE }
    }
    if (!failure) {
      throw error
    }
    return {
      status: 'ok' as const,
      value: {
        operationId: request.operationId,
        status: failure.category === 'cancelled' ? ('cancelled' as const) : ('failed' as const),
        name: grant.version.name,
        packageDigest: request.package.packageDigest,
        placements: [],
        errorCategory: failure.code,
        failure
      }
    }
  }
}
