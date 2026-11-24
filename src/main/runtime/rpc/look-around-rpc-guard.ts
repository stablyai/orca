import {
  LOOK_AROUND_REFUSAL,
  lookAroundOrchestrationAllowed,
  REPLY_ONLY_REFUSAL
} from '../../bots/bot-look-around-policy'
import type { BotLookAroundStore } from '../../bots/bot-look-around-store'
import { InvalidArgumentError } from './core'

/** An orchestration call from a look-around run may only read: no workers, runs or messages. A
 *  tidy-up run calls nothing: its inputs are all in its prompt. */
export function assertLookAroundMayCall(
  // Runtime test fakes may omit the store.
  runtime: { lookAround?: Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp'> },
  request: { method: string; orchestrationCompatibilityEvidence?: { agentSessionId?: string } },
  pairedDeviceId: string | undefined,
  params?: unknown
): void {
  if (pairedDeviceId !== undefined) {
    return
  }
  const sessionId = request.orchestrationCompatibilityEvidence?.agentSessionId
  const caller =
    typeof params === 'object' && params !== null && 'callerSessionId' in params
      ? params.callerSessionId
      : undefined
  for (const id of [sessionId, caller]) {
    if (typeof id === 'string' && id && runtime.lookAround?.botOfTidyUp(id)) {
      throw new InvalidArgumentError(REPLY_ONLY_REFUSAL)
    }
  }
  if (
    sessionId &&
    request.method.startsWith('orchestration.') &&
    !lookAroundOrchestrationAllowed(request.method) &&
    runtime.lookAround?.botOfLook(sessionId)
  ) {
    throw new InvalidArgumentError(LOOK_AROUND_REFUSAL)
  }
}
