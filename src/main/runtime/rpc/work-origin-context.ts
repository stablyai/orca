import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { WorkOrigin } from '../../../shared/work-origin'
import type { RpcContext } from './core'

export function resolveRpcWorkOrigin(
  context: Pick<RpcContext, 'runtime' | 'pairedDeviceId' | 'clientKind'>,
  caller: {
    callerOriginSession?: { sessionId: string; spawnToken: string }
    callerTerminalHandle?: string
    cliProvenanceRequest?: unknown
  } = {}
): WorkOrigin {
  if (caller.callerOriginSession) {
    const { sessionId, spawnToken } = caller.callerOriginSession
    return getStructuredAgentSessionHost()?.resolveChildWorkOrigin(sessionId, spawnToken) ?? null
  }
  if (caller.callerTerminalHandle) {
    return context.runtime.getTerminalWorkOrigin(caller.callerTerminalHandle) ?? null
  }
  if (caller.cliProvenanceRequest !== undefined) {
    return null
  }
  if (context.pairedDeviceId) {
    return { kind: 'paired-device', deviceId: context.pairedDeviceId }
  }
  return context.clientKind ? null : { kind: 'host' }
}
