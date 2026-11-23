import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import type { RpcCallerIdentity } from '../runtime/rpc/callers/rpc-caller-identity'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeBotGroups } from './bot-group-runtime'

export function assertBotGroupSessionAccess(
  runtime: OrcaRuntimeService,
  sessionId: string,
  caller: RpcCallerIdentity | undefined,
  readOnly = false
): void {
  if (!isBotGroupMemberSession(sessionId)) {
    return
  }
  if (caller?.kind !== 'desktop' && caller?.kind !== 'paired-device') {
    throw new Error(
      'Only a human can operate a group bot session. Use explicit bot questions and handoffs for peer work.'
    )
  }
  if (readOnly) {
    return
  }
  if (!runtimeBotGroups(runtime).store.memberOf(sessionId)) {
    throw new Error('This bot is no longer a member of the group.')
  }
}
