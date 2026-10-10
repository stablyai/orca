import type { RuntimeCapability } from '../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import {
  SkillBundleInstallProgressSchema,
  SkillBundleInstallResultSchema,
  type SkillBundleInstallProgress,
  type SkillBundleInstallRequest,
  type SkillBundleInstallResult
} from '../../shared/skill-bundle-install-contract'
import {
  SkillInstallResultSchema,
  type SkillInstallRequest,
  type SkillInstallResult
} from '../../shared/skill-install-contract'
import {
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY
} from '../../shared/skill-install-capability'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { transferSkillPackageToRuntime } from './skill-client-mediated-transfer'
import { SkillInstallFailureSchema } from '../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'
import { recordSkillCapabilityAbsence } from './skill-operation-observability'
import { startSkillInstallProgressPolling } from './skill-install-progress-polling'
import { retrySkillTransferRpc } from './skill-transfer-rpc-retry'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../shared/remote-runtime-client-error-classification'

const DIRECT_DOWNLOAD_FAILURE = 'skill-download-transport-failed'
const DEVELOPMENT_DOWNLOAD_POLICY_FAILURES = new Set([
  'skill-download-url-rejected',
  'skill-download-origin-rejected'
])

async function install(
  userDataPath: string,
  environmentId: string,
  request: SkillInstallRequest,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<unknown>> {
  const args = [userDataPath, environmentId, 'skills.install', request, 5 * 60_000] as const
  return (await (signal
    ? callRuntimeEnvironment(...args, undefined, undefined, { signal })
    : callRuntimeEnvironment(...args))) as RuntimeRpcResponse<unknown>
}

async function installBundle(
  userDataPath: string,
  environmentId: string,
  request: SkillBundleInstallRequest,
  signal?: AbortSignal
): Promise<RuntimeRpcResponse<unknown>> {
  const args = [userDataPath, environmentId, 'skills.installBundle', request, 5 * 60_000] as const
  return (await (signal
    ? callRuntimeEnvironment(...args, undefined, undefined, { signal })
    : callRuntimeEnvironment(...args))) as RuntimeRpcResponse<unknown>
}

async function readBundleInstallProgress(
  userDataPath: string,
  environmentId: string,
  operationId: string
): Promise<SkillBundleInstallProgress | null> {
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'skills.getInstallProgress',
    { operationId },
    2_000
  )
  if (response.ok !== true || response.result === null) {
    return null
  }
  const parsed = SkillBundleInstallProgressSchema.safeParse(response.result)
  return parsed.success ? parsed.data : null
}

function isDirectDownloadUnavailable(
  response: RuntimeRpcResponse<unknown>,
  requireHttps: boolean
): boolean {
  const structured =
    response.ok === false ? SkillInstallFailureSchema.safeParse(response.error.data) : null
  if (response.ok === true) {
    return false
  }
  const codes = [
    response.error.code,
    response.error.message,
    ...(structured?.success === true ? [structured.data.code] : [])
  ]
  return (
    codes.includes(DIRECT_DOWNLOAD_FAILURE) ||
    (!requireHttps && codes.some((code) => DEVELOPMENT_DOWNLOAD_POLICY_FAILURES.has(code)))
  )
}

function remoteFailure(response: RuntimeRpcResponse<unknown>): Error {
  if (response.ok === true) {
    return new Error('skill-install-remote-response-invalid')
  }
  const failure = SkillInstallFailureSchema.safeParse(response.error.data)
  return failure.success
    ? new SkillInstallOperationError(failure.data)
    : new Error('skill-install-remote-failed')
}

function retryableRemoteInstallTransportError(error: unknown): boolean {
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}

export async function installSkillOnRemoteRuntime(input: {
  userDataPath: string
  environmentId: string
  request: SkillInstallRequest
  capabilities: readonly RuntimeCapability[]
  requireHttps: boolean
  signal?: AbortSignal
}): Promise<SkillInstallResult> {
  const request = input.request
  if (
    request.providers !== undefined &&
    !input.capabilities.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY)
  ) {
    throw new Error('skill-install-remote-update-required')
  }
  if (request.ingress.kind !== 'download-grant') {
    throw new Error('skill-install-remote-ingress-invalid')
  }
  const grant = request.ingress
  const direct = await retrySkillTransferRpc({
    signal: input.signal,
    retryable: retryableRemoteInstallTransportError,
    call: () => install(input.userDataPath, input.environmentId, request, input.signal)
  })
  if (!isDirectDownloadUnavailable(direct, input.requireHttps)) {
    if (direct.ok !== true) {
      throw remoteFailure(direct)
    }
    return SkillInstallResultSchema.parse(direct.result)
  }
  if (!input.capabilities.includes(SKILL_UPLOAD_CAPABILITY)) {
    recordSkillCapabilityAbsence({
      capability: SKILL_UPLOAD_CAPABILITY,
      destination: 'remote-runtime'
    })
    throw new Error('skill-install-remote-download-unavailable')
  }

  return retrySkillTransferRpc({
    signal: input.signal,
    retryable: retryableRemoteInstallTransportError,
    call: async () => {
      const transfer = await transferSkillPackageToRuntime({
        userDataPath: input.userDataPath,
        environmentId: input.environmentId,
        transferId: request.operationId,
        package: request.package,
        grant,
        requireHttps: input.requireHttps,
        signal: input.signal
      })
      try {
        const staged = await install(
          input.userDataPath,
          input.environmentId,
          {
            ...request,
            ingress: { kind: 'staged-upload', uploadId: transfer.uploadId }
          },
          input.signal
        )
        if (staged.ok !== true) {
          throw remoteFailure(staged)
        }
        return SkillInstallResultSchema.parse(staged.result)
      } finally {
        await transfer.cleanup().catch(() => undefined)
      }
    }
  })
}

export async function installSkillBundleOnRemoteRuntime(input: {
  userDataPath: string
  environmentId: string
  request: SkillBundleInstallRequest
  capabilities: readonly RuntimeCapability[]
  requireHttps: boolean
  signal?: AbortSignal
  onProgress?: (progress: SkillBundleInstallProgress) => void
}): Promise<SkillBundleInstallResult> {
  const request = input.request
  if (
    request.providers !== undefined &&
    !input.capabilities.includes(SKILL_INSTALL_PROVIDERS_CAPABILITY)
  ) {
    throw new Error('skill-bundle-remote-update-required')
  }
  if (request.ingress.kind !== 'download-grant') {
    throw new Error('skill-bundle-remote-ingress-invalid')
  }
  if (!input.capabilities.includes(SKILL_BUNDLE_INSTALL_CAPABILITY)) {
    recordSkillCapabilityAbsence({
      capability: SKILL_BUNDLE_INSTALL_CAPABILITY,
      destination: 'remote-runtime'
    })
    throw new Error('skill-bundle-remote-ingress-invalid')
  }
  const stopProgress =
    input.onProgress && input.capabilities.includes(SKILL_INSTALL_PROGRESS_CAPABILITY)
      ? startSkillInstallProgressPolling({
          read: () =>
            readBundleInstallProgress(input.userDataPath, input.environmentId, request.operationId),
          onProgress: input.onProgress
        })
      : null
  try {
    const grant = request.ingress
    const direct = await retrySkillTransferRpc({
      signal: input.signal,
      retryable: retryableRemoteInstallTransportError,
      call: () => installBundle(input.userDataPath, input.environmentId, request, input.signal)
    })
    if (!isDirectDownloadUnavailable(direct, input.requireHttps)) {
      if (direct.ok !== true) {
        throw remoteFailure(direct)
      }
      return SkillBundleInstallResultSchema.parse(direct.result)
    }
    if (!input.capabilities.includes(SKILL_UPLOAD_CAPABILITY)) {
      recordSkillCapabilityAbsence({
        capability: SKILL_UPLOAD_CAPABILITY,
        destination: 'remote-runtime'
      })
      throw new Error('skill-bundle-remote-download-unavailable')
    }
    return retrySkillTransferRpc({
      signal: input.signal,
      retryable: retryableRemoteInstallTransportError,
      call: async () => {
        const transfer = await transferSkillPackageToRuntime({
          userDataPath: input.userDataPath,
          environmentId: input.environmentId,
          transferId: request.operationId,
          package: request.package,
          grant,
          requireHttps: input.requireHttps,
          signal: input.signal
        })
        try {
          const staged = await installBundle(
            input.userDataPath,
            input.environmentId,
            {
              ...request,
              ingress: { kind: 'staged-upload', uploadId: transfer.uploadId }
            },
            input.signal
          )
          if (staged.ok !== true) {
            throw remoteFailure(staged)
          }
          return SkillBundleInstallResultSchema.parse(staged.result)
        } finally {
          await transfer.cleanup().catch(() => undefined)
        }
      }
    })
  } finally {
    stopProgress?.()
  }
}
