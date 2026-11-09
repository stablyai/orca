// The desktop's one handle on org environments: a lazily built control-plane client plus the
// Result mapping the IPC and runtime RPC surfaces share.
import type {
  OrcaCloudEnvironmentError,
  OrcaCloudEnvironmentResult
} from '../../../shared/hosted-sandbox/hosted-environment-api'
import { hostedEnvironmentError } from '../../../shared/hosted-sandbox/hosted-environment-errors'
import type { HostedSandboxConfig } from '../hosted-sandbox-config'
import {
  createHostedEnvironmentClient,
  HostedEnvironmentRequestError,
  HostedEnvironmentUserError,
  type HostedEnvironmentClient
} from './hosted-environment-client'

export type HostedEnvironmentService = {
  isConfigured(): boolean
  /** Throws HostedEnvironmentRequestError('not_configured') when this build has no control plane. */
  client(): HostedEnvironmentClient
}

export function createHostedEnvironmentService(
  loadConfig: () => HostedSandboxConfig | null,
  fetchImpl?: typeof fetch
): HostedEnvironmentService {
  let resolved: { client: HostedEnvironmentClient | null } | null = null
  const resolve = (): HostedEnvironmentClient | null => {
    if (!resolved) {
      const config = loadConfig()
      resolved = {
        client: config
          ? createHostedEnvironmentClient({
              baseUrl: config.controlPlaneUrl,
              getAccessToken: config.getAccessToken,
              fetch: fetchImpl
            })
          : null
      }
    }
    return resolved.client
  }
  return {
    isConfigured: () => resolve() !== null,
    client: () => {
      const client = resolve()
      if (!client) {
        throw new HostedEnvironmentRequestError(
          'not_configured',
          null,
          'Orca Cloud is not set up in this build of Orca.'
        )
      }
      return client
    }
  }
}

export function toHostedEnvironmentError(error: unknown): OrcaCloudEnvironmentError {
  if (error instanceof HostedEnvironmentUserError) {
    return {
      code: error.code,
      ...(error.reason ? { reason: error.reason } : {}),
      message: error.message
    }
  }
  if (error instanceof HostedEnvironmentRequestError) {
    return hostedEnvironmentError(error.code, error.reason)
  }
  console.warn('[cloud-environments] unexpected failure:', error)
  return hostedEnvironmentError('unavailable')
}

export async function hostedEnvironmentResult<T>(
  work: () => Promise<T>
): Promise<OrcaCloudEnvironmentResult<T>> {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    return { ok: false, error: toHostedEnvironmentError(error) }
  }
}

let registered: HostedEnvironmentService | null = null

/** Desktop main publishes the service for the runtime RPC (CLI); a headless host has none. */
export function registerHostedEnvironmentService(service: HostedEnvironmentService | null): void {
  registered = service
}

export function getHostedEnvironmentService(): HostedEnvironmentService | null {
  return registered
}
