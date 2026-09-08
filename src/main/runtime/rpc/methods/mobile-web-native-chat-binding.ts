import { z } from 'zod'
import { MobileWebNativeChatSessionIdSchema } from '../../../../shared/mobile-web/native-chat-target-contract'
import type { RpcContext } from '../core'
import { mobileWebNativeChatBinding } from './mobile-web-session-snapshot'

export const MobileWebChatScope = z.object({ worktree: z.string().min(1).max(4096) })
export const MobileWebChatTarget = MobileWebChatScope.extend({
  tabId: z.string().min(1).max(512),
  sessionId: MobileWebNativeChatSessionIdSchema
})

export type MobileWebNativeChatBinding = {
  tabId: string
  agent: string
  sessionId: string
  transcriptPath?: string
  terminal: string
  worktreeId: string
}

/** Resolves the page's `{tabId, sessionId}` against the live host tab list. Callers resolve once
 *  per request: a second enumeration cannot narrow the race the first one already lost. */
export async function resolveMobileWebNativeChat(
  context: RpcContext,
  params: z.infer<typeof MobileWebChatTarget>
): Promise<MobileWebNativeChatBinding> {
  const snapshot = await context.runtime.listMobileSessionTabs(
    params.worktree,
    context.pairedDeviceId
  )
  if (`id:${snapshot.worktree}` !== params.worktree) {
    throw new Error('selector_not_found')
  }
  const binding = mobileWebNativeChatBinding(
    snapshot.tabs.find((tab) => tab.id === params.tabId),
    snapshot.worktree
  )
  if (!binding?.hostTerminalId || binding.providerSessionId !== params.sessionId) {
    throw new Error('selector_not_found')
  }
  return {
    tabId: binding.hostTabId,
    agent: binding.agent,
    sessionId: binding.providerSessionId,
    transcriptPath: binding.transcriptPath,
    terminal: binding.hostTerminalId,
    worktreeId: binding.hostWorkspaceId
  }
}

export function mobileWebNativeChatHostParams(
  binding: MobileWebNativeChatBinding,
  params: Record<string, unknown>
) {
  return {
    ...params,
    agent: binding.agent,
    sessionId: binding.sessionId,
    transcriptPath: binding.transcriptPath,
    terminal: binding.terminal,
    worktreeId: binding.worktreeId
  }
}
