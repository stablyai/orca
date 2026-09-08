import { z } from 'zod'
import { defineMethod, isStreamingMethod, type RpcContext } from '../core'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import { MobileWebWorktreeScope } from './mobile-web-source-control-host-method'
import { MOBILE_WEB_REVIEW_TERMINAL_TEXT_MAX_CHARACTERS } from '../../../../shared/mobile-web/source-control-review-contract'

const Tab = z.object({
  id: z.string(),
  type: z.literal('terminal'),
  status: z.literal('ready'),
  terminal: z.string().min(1).max(256)
})

const send = TERMINAL_SEND_METHODS.find((method) => method.name === 'terminal.send')
if (!send || isStreamingMethod(send)) {
  throw new Error('Missing terminal.send method')
}
const terminalSend = send

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_TERMINAL_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewTerminalSend',
    params: MobileWebWorktreeScope.extend({
      tabId: z.string().min(1).max(512),
      text: z.string().min(1).max(MOBILE_WEB_REVIEW_TERMINAL_TEXT_MAX_CHARACTERS)
    }),
    handler: async (params, context) => {
      if (!context.clientId) {
        throw new Error('runtime_unavailable')
      }
      // The handle comes from the host tab list for this worktree, never from the request.
      const terminal = await resolveTerminal(context, params.worktree, params.tabId)
      const result = await terminalSend.handler(
        terminalSend.params!.parse({
          terminal,
          text: params.text,
          enter: true,
          client: { id: context.clientId, type: 'mobile' }
        }),
        context
      )
      return { accepted: acceptedSend(result) }
    }
  })
]

async function resolveTerminal(
  context: RpcContext,
  worktree: string,
  tabId: string
): Promise<string> {
  const snapshot = await context.runtime.listMobileSessionTabs(worktree, context.pairedDeviceId)
  if (`id:${snapshot.worktree}` !== worktree) {
    throw new Error('selector_not_found')
  }
  const parsed = Tab.safeParse(snapshot.tabs.find((tab) => tab.id === tabId))
  if (!parsed.success) {
    throw new Error('selector_not_found')
  }
  return parsed.data.terminal
}

function acceptedSend(result: unknown): boolean {
  const parsed = z.object({ send: z.object({ accepted: z.boolean() }) }).safeParse(result)
  if (!parsed.success) {
    throw new Error('host_error')
  }
  return parsed.data.send.accepted
}
