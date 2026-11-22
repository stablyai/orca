import { truncateToolDetail } from '../../../shared/native-chat/tools/native-chat-tool-summary'
import { readAcpPermissionRequest } from '../protocol/acp-permission-requests'
import { AcpRpcError } from '../transport/acp-errors'
import { pendingAcpResolution, type AcpRequestPresentation } from './acp-dialect'

const PLAN_APPROVAL_OPTIONS = [
  { id: 'allow', label: 'Approve plan', intent: 'allow_once' },
  { id: 'deny', label: 'Keep planning', intent: 'reject_once' }
] as const

// Droid leaves Spec at the level its answer names: proceed_once runs normal, the rest auto-<risk>.
function approvingOptionId(buildMode: string | undefined): string {
  return buildMode?.startsWith('auto-')
    ? `proceed_auto_run_${buildMode.slice('auto-'.length)}`
    : 'proceed_once'
}

function readSpec(input: unknown): { title: string | null; plan: string | null } {
  if (typeof input !== 'object' || input === null) {
    return { title: null, plan: null }
  }
  return {
    title: 'title' in input && typeof input.title === 'string' ? input.title : null,
    plan: 'plan' in input && typeof input.plan === 'string' ? input.plan : null
  }
}

/** Droid's spec approval as Orca's plan card; approving continues at the chat's own permission. */
export function droidSpecApproval(
  method: string,
  params: unknown
): AcpRequestPresentation | undefined {
  const request =
    method === 'session/request_permission' ? readAcpPermissionRequest(params, () => {}) : null
  const spec = request?.toolCall.kind === 'switch_mode' ? readSpec(request.toolCall.rawInput) : null
  const plan = spec?.plan
  if (!request || !spec || plan == null) {
    return undefined
  }
  const offered = request.options
  return {
    body: {
      kind: 'approval',
      title: spec.title ?? 'Review proposed plan',
      subject: { kind: 'plan', text: plan },
      detail: truncateToolDetail(plan) || null,
      options: PLAN_APPROVAL_OPTIONS.map((option) => ({ ...option })),
      resolution: pendingAcpResolution
    },
    reply: (response, context) => {
      if (response === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      if (
        response.kind !== 'option' ||
        !PLAN_APPROVAL_OPTIONS.some((option) => option.id === response.optionId)
      ) {
        throw new AcpRpcError(-32602, 'Plan answer must select an offered option')
      }
      const approving = response.optionId === 'allow'
      const wanted = approving ? approvingOptionId(context?.buildMode) : 'cancel'
      const kind = approving ? 'allow_once' : 'reject_once'
      const option =
        offered.find((entry) => entry.optionId === wanted) ??
        offered.find((entry) => entry.kind === kind)
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    }
  }
}
