import { RequestPermissionResponseSchema } from '../generated/acp-protocol.generated'
import type { AcpPermissionHandler } from '../protocol/acp-permission-requests'
import { acpAnswersRequests } from '../launch/acp-launch-permission-modes'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import * as childState from '../session/children/acp-structured-child'
import type { AcpStructuredPrompts } from './acp-structured-prompts'
import { ACP_FORM_ELICITATION_METHOD } from './acp-form-elicitation'
import { AcpRpcError } from '../transport/acp-errors'
import type { AcpRequestContext } from '../transport/acp-json-rpc-peer'
import { REPLY_ONLY_REFUSAL } from '../../bots/bot-look-around-policy'

/** A chat's permission answers: none while nobody can answer, Orca's own in full access, else the person's. */
export function acpStructuredPermissionHandler(
  session: () => childState.AcpStructuredChild | null,
  spec: AcpLaunchSpec,
  prompts: AcpStructuredPrompts
): AcpPermissionHandler {
  return (request, context) => {
    const child = session()
    if (!childState.isAcpReadySession(child) || !child.turns?.acceptsRequests) {
      // Nobody can answer during Stop, a steer or teardown.
      return { outcome: { outcome: 'cancelled' } }
    }
    if (child.readOnly === 'reply-only') {
      const reject = request.options.find(
        (option) => option.kind === 'reject_once' || option.kind === 'reject_always'
      )
      return {
        outcome: reject
          ? { outcome: 'selected', optionId: reject.optionId }
          : { outcome: 'cancelled' }
      }
    }
    // Do not auto-approve questions or permissions enforced by the agent's own mode.
    const claimed = spec.dialect.request?.('session/request_permission', request)
    if (child.permission === 'full-access' && acpAnswersRequests(spec) && !claimed) {
      const allow = request.options.find((option) => option.kind === 'allow_once')
      if (allow) {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
    }
    return prompts
      .handle('session/request_permission', request, context)
      .then((reply) => RequestPermissionResponseSchema.parse(reply))
  }
}

/** Client-side ACP request handler: cancels elicitations and refuses other requests in reply-only runs. */
export function acpStructuredRequestHandler(
  session: () => childState.AcpStructuredChild | null,
  prompts: AcpStructuredPrompts
): (method: string, params: unknown, context: AcpRequestContext) => Promise<unknown> {
  return (method, params, context) => {
    if (session()?.readOnly === 'reply-only') {
      if (method === ACP_FORM_ELICITATION_METHOD) {
        return Promise.resolve({ action: 'cancel' })
      }
      throw new AcpRpcError(-32601, REPLY_ONLY_REFUSAL)
    }
    return prompts.handle(method, params, context)
  }
}
