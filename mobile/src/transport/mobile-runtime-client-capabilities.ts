import {
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../src/shared/remote-runtime-client-capabilities'

export const MOBILE_RUNTIME_CLIENT_CAPABILITIES = remoteRuntimeClientCapabilities([
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY
])

export const MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD =
  'runtime.clientCapabilities.update' as const

export function mobileRuntimeClientCapabilityUpdateParams(): {
  clientCapabilities: string[]
} {
  return { clientCapabilities: [...MOBILE_RUNTIME_CLIENT_CAPABILITIES] }
}

export function mobileRuntimeClientCapabilityUpdateRequest(args: {
  id: string
  deviceToken: string
}): {
  id: string
  deviceToken: string
  method: typeof MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD
  params: { clientCapabilities: string[] }
} {
  return {
    id: args.id,
    deviceToken: args.deviceToken,
    method: MOBILE_RUNTIME_CLIENT_CAPABILITY_UPDATE_METHOD,
    params: mobileRuntimeClientCapabilityUpdateParams()
  }
}

export function advertiseMobileRuntimeClientCapabilities(
  send: (request: unknown) => boolean | void,
  id: string,
  deviceToken: string
): void {
  send(mobileRuntimeClientCapabilityUpdateRequest({ id, deviceToken }))
}
