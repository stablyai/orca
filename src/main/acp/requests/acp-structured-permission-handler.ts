import { RequestPermissionResponseSchema } from '../generated/acp-protocol.generated'
import type { AcpPermissionHandler } from '../protocol/acp-permission-requests'
import { acpAnswersRequests } from '../launch/acp-launch-permission-modes'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import * as childState from '../session/children/acp-structured-child'
import type { AcpStructuredPrompts } from './acp-structured-prompts'

/** A chat's permission answers: none while nobody can answer, Orca's own in full access, else the person's. */
export function acpStructuredPermissionHandler(
  session: () => childState.AcpStructuredChild | null,
  spec: AcpLaunchSpec,
  prompts: AcpStructuredPrompts
): AcpPermissionHandler | undefined {
  if (spec.autonomousTools) {
    return undefined
  }
  return (request, context) => {
    const child = session()
    if (!childState.isAcpReadySession(child) || !child.turns?.acceptsRequests) {
      // Nobody can answer during Stop, a steer or teardown.
      return { outcome: { outcome: 'cancelled' } }
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
