// Orca Cloud secrets on the sandbox control plane. Write-only for values: requests carry them, no
// response or error does, and nothing here logs a request body.
import {
  CloudEnvRefreshResponseSchema,
  CloudSecretBatchResponseSchema,
  CloudSecretDeleteResponseSchema,
  CloudSecretListResponseSchema,
  CloudSecretPutResponseSchema,
  CloudSecretsEffectiveResponseSchema,
  cloudSecretsErrorCode,
  type CloudSecretBatchResult,
  type CloudSecretsErrorCode,
  type CloudSecretTarget,
  type CloudSecretView,
  type CloudSecretsEffective
} from '../../shared/cloud-secrets/cloud-secrets-wire'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import {
  createHostedSandboxRequest,
  type HostedSandboxControlPlaneClientOptions
} from '../hosted-sandbox/hosted-sandbox-request'

export type CloudSecretsClient = {
  list(target: CloudSecretTarget, signal?: AbortSignal): Promise<CloudSecretView[]>
  put(target: CloudSecretTarget, name: string, value: string): Promise<CloudSecretView>
  remove(target: CloudSecretTarget, name: string): Promise<void>
  batch(
    target: CloudSecretTarget,
    change: { set?: Record<string, string>; delete?: string[] }
  ): Promise<CloudSecretBatchResult>
  effective(repo?: string, signal?: AbortSignal): Promise<CloudSecretsEffective>
  refreshEnv(sandboxId: string): Promise<boolean>
}

function withRepo(path: string, repo: string | undefined): string {
  return repo ? `${path}?${new URLSearchParams({ repo })}` : path
}

export function createCloudSecretsClient(
  options: HostedSandboxControlPlaneClientOptions
): CloudSecretsClient {
  const call = createHostedSandboxRequest(options)
  const secretPath = (target: CloudSecretTarget, suffix: string): string =>
    withRepo(`v1/secrets/${encodeURIComponent(target.scope)}/${suffix}`, target.repo)

  return {
    list: async (target, signal) =>
      (
        await call(
          'GET',
          `v1/secrets?${new URLSearchParams({
            scope: target.scope,
            ...(target.repo ? { repo: target.repo } : {})
          })}`,
          CloudSecretListResponseSchema,
          { kind: 'control', signal }
        )
      ).secrets,
    put: async (target, name, value) =>
      (
        await call(
          'PUT',
          secretPath(target, encodeURIComponent(name)),
          CloudSecretPutResponseSchema,
          {
            body: { value },
            kind: 'control'
          }
        )
      ).secret,
    remove: async (target, name) => {
      await call(
        'DELETE',
        secretPath(target, encodeURIComponent(name)),
        CloudSecretDeleteResponseSchema,
        { kind: 'control' }
      )
    },
    batch: (target, change) =>
      call('POST', secretPath(target, 'batch'), CloudSecretBatchResponseSchema, {
        body: change,
        kind: 'control'
      }),
    effective: (repo, signal) =>
      call('GET', withRepo('v1/secrets/effective', repo), CloudSecretsEffectiveResponseSchema, {
        kind: 'control',
        signal
      }),
    refreshEnv: async (sandboxId) =>
      (
        await call(
          'POST',
          `v1/sandboxes/${encodeURIComponent(sandboxId)}/env/refresh`,
          CloudEnvRefreshResponseSchema,
          { kind: 'control' }
        )
      ).applied
  }
}

/** The code the renderer turns into copy: the server reason when it gave one. */
export function cloudSecretsFailureCode(error: unknown): CloudSecretsErrorCode {
  if (!isEnvironmentProviderError(error)) {
    return 'unknown'
  }
  switch (error.code) {
    case 'unauthorized':
      return cloudSecretsErrorCode(error.reason, 'unauthorized')
    case 'not_found':
      return 'not_found'
    case 'timeout':
      return 'timeout'
    case 'invalid_request':
    case 'conflict':
      return cloudSecretsErrorCode(error.reason)
    case 'unavailable':
    case 'aborted':
    case 'invalid_response':
      return 'unavailable'
  }
}
