import type { PtyConsumerSessionHello } from '../shared/pty-consumer-session'
import type { RelayClientSessionIdentity, RequestContext } from './dispatcher'

export type OpenClientParams = PtyConsumerSessionHello & {
  protocolVersion: number
}

// Why every field is coerced rather than trusted: these arrive off the wire from a peer that may be
// a different build, so a missing or wrong-typed member has to degrade into a value the session can
// reject by contract instead of throwing somewhere further in.
export function parseOpenClientParams(params: Record<string, unknown>): OpenClientParams {
  const resume =
    typeof params.resume === 'object' && params.resume !== null
      ? (params.resume as Record<string, unknown>)
      : undefined
  const capabilities =
    typeof params.capabilities === 'object' && params.capabilities !== null
      ? (params.capabilities as Record<string, unknown>)
      : undefined
  const outputFlowControl =
    typeof capabilities?.outputFlowControl === 'object' && capabilities.outputFlowControl !== null
      ? (capabilities.outputFlowControl as Record<string, unknown>)
      : undefined
  return {
    protocolVersion: Number(params.protocolVersion),
    clientInstanceId: String(params.clientInstanceId ?? ''),
    requestedRole: String(params.requestedRole ?? '') as PtyConsumerSessionHello['requestedRole'],
    ...(resume
      ? {
          resume: {
            ownerGeneration: Number(resume.ownerGeneration),
            ownerLease: String(resume.ownerLease ?? '')
          }
        }
      : {}),
    ...(outputFlowControl
      ? {
          capabilities: {
            outputFlowControl: {
              versions: Array.isArray(outputFlowControl.versions)
                ? outputFlowControl.versions.map(Number)
                : [],
              requestedWindowSu: Number(outputFlowControl.requestedWindowSu)
            }
          }
        }
      : {})
  }
}

export function requireIdentity(context: RequestContext): RelayClientSessionIdentity {
  if (!context.sessionIdentity) {
    throw new Error('SSH PTY consumer transport identity is unavailable')
  }
  return context.sessionIdentity
}
