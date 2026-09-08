import { z } from 'zod'
import type { RpcContext } from '../core'
import { isStreamingMethod } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'

export const MobileWebSessionScope = z.object({
  worktree: z.string().min(1).max(4096),
  workspaceId: z.string().min(1).max(160)
})
export function mobileWebSessionMethod(name: string) {
  const method = SESSION_TAB_METHODS.find((entry) => entry.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing session method: ${name}`)
  }
  return method
}

export function projectMobileWebSession(
  result: unknown,
  params: z.infer<typeof MobileWebSessionScope>,
  context: RpcContext
) {
  if (context.signal?.aborted) {
    throw new Error('runtime_unavailable')
  }
  const { worktree: workspace } = z.object({ worktree: z.string() }).parse(result)
  if (`id:${workspace}` !== params.worktree) {
    throw new Error('selector_not_found')
  }
  return mobileWebSessionSnapshot(result, workspace, params.workspaceId)
}
