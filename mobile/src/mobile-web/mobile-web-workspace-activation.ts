import {
  MobileWebWorkspaceActivationResultSchema,
  type MobileWebWorkspaceActivationResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'

export function mobileWebWorkspaceActivation(
  result: unknown,
  hostWorkspaceId: string,
  pageWorkspaceId: string
): MobileWebWorkspaceActivationResult {
  if (!isRecord(result) || result.worktreeId !== hostWorkspaceId) {
    throw new Error('mobile_web_workspace_activation_invalid')
  }
  const parsed = MobileWebWorkspaceActivationResultSchema.safeParse({
    workspaceId: pageWorkspaceId,
    activated: result.activated,
    sleepingAgentWake: result.sleepingAgentWake
  })
  if (!parsed.success) {
    throw new Error('mobile_web_workspace_activation_invalid')
  }
  return parsed.data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
