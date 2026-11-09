// Enrolls a paired phone's key with the Orca Cloud control plane as this desktop's signed-in user,
// and ends that access when the phone is unpaired here.
import { z } from 'zod'
import {
  ORCA_CLOUD_ENROLLMENT_REFUSED,
  ORCA_CLOUD_ENROLLMENT_SIGNED_OUT,
  ORCA_CLOUD_ENROLLMENT_UNAVAILABLE,
  OrcaCloudDeviceSessionSchema
} from '../../shared/orca-cloud-device-enrollment-contract'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { OrcaCloudDeviceEnroller } from '../runtime/rpc/methods/orca-cloud/orca-cloud-device-enrollment'
import type { HostedSandboxConfig } from './hosted-sandbox-config'

const EnrollResponseSchema = z.object({ deviceSession: OrcaCloudDeviceSessionSchema })

export function createHostedSandboxDeviceEnroller(
  config: HostedSandboxConfig,
  fetchImpl: typeof fetch = fetch
): OrcaCloudDeviceEnroller {
  async function token(): Promise<string> {
    try {
      return await config.getAccessToken()
    } catch (error) {
      throw new Error(
        error instanceof EnvironmentProviderError && error.code === 'unauthorized'
          ? ORCA_CLOUD_ENROLLMENT_SIGNED_OUT
          : ORCA_CLOUD_ENROLLMENT_UNAVAILABLE
      )
    }
  }
  async function send(method: 'POST' | 'DELETE', path: string, body?: unknown) {
    const bearer = await token()
    return await fetchImpl(new URL(path, `${config.controlPlaneUrl}/`), {
      method,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    }).catch(() => null)
  }
  return {
    enroll: async (params) => {
      const response = await send('POST', '/v1/device-sessions', params)
      if (response?.status === 401) {
        throw new Error(ORCA_CLOUD_ENROLLMENT_SIGNED_OUT)
      }
      // 409: device limit reached or a revoked key; the phone rotates its key and asks again.
      if (response?.status === 409) {
        throw new Error(ORCA_CLOUD_ENROLLMENT_REFUSED)
      }
      if (!response?.ok) {
        throw new Error(ORCA_CLOUD_ENROLLMENT_UNAVAILABLE)
      }
      const body = EnrollResponseSchema.safeParse(await response.json().catch(() => null))
      if (!body.success) {
        throw new Error(ORCA_CLOUD_ENROLLMENT_UNAVAILABLE)
      }
      return { controlPlaneUrl: config.controlPlaneUrl, deviceSession: body.data.deviceSession }
    },
    revokeForPairedDevice: async (pairedDeviceId) => {
      await send(
        'DELETE',
        `/v1/device-sessions?pairedDeviceId=${encodeURIComponent(pairedDeviceId)}`
      )
    }
  }
}
