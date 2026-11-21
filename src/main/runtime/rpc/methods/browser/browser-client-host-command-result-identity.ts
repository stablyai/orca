import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE } from '../../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserError } from '../../../../browser/browser-error'
import type { RpcContext } from '../../core'

export function requireCommandResultIdentity(
  params: {
    authorityRuntimeId: string
    authorityEpoch: string
    browserHostClientId: string
    browserHostGeneration: number
  },
  context: Pick<
    RpcContext,
    'runtime' | 'pairedDeviceId' | 'connectionId' | 'clientKind' | 'clientCapabilities'
  >
) {
  const { runtime, pairedDeviceId, connectionId, clientKind, clientCapabilities } = context
  if (clientKind !== 'runtime' || !pairedDeviceId || !connectionId) {
    throw new Error('authenticated_browser_client_host_required')
  }
  if (!clientCapabilities?.includes(BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY)) {
    throw new Error('browser_client_host_capability_required')
  }
  if (params.authorityRuntimeId !== runtime.getRuntimeId()) {
    throw new BrowserError(
      BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE,
      BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE
    )
  }
  return {
    authorityEpoch: params.authorityEpoch,
    browserHostClientId: params.browserHostClientId,
    browserHostGeneration: params.browserHostGeneration,
    pairedDeviceId,
    connectionId
  }
}
