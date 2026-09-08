import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { resolveMobileWebTerminalTab } from './mobile-web-terminal-tab-resolution'
import { TERMINAL_QUERY_METHODS } from './terminal/terminal-query-methods'
import { TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS } from './terminal/terminal-viewport-methods'

const ACTION_METHODS = ['terminal.setDisplayMode', 'terminal.clearBuffer', 'terminal.rename']
const actions = new Map(
  [...TERMINAL_QUERY_METHODS, ...TERMINAL_VIEWPORT_METHODS_BEFORE_STREAMS]
    .filter((method) => ACTION_METHODS.includes(method.name))
    .map((method) => [method.name, method])
)

export const MOBILE_WEB_TERMINAL_ACTION_METHODS = [
  defineMethod({
    name: 'mobileWeb.terminal.action',
    params: z.object({
      worktree: z.string().min(1).max(4096),
      tabId: z.string().min(1).max(512),
      timeoutMs: z.number().int().min(1).max(15_000),
      method: z.enum(['terminal.setDisplayMode', 'terminal.clearBuffer', 'terminal.rename']),
      fields: z.record(z.string(), z.unknown())
    }),
    handler: async (params, context) => {
      const deadline = Date.now() + params.timeoutMs
      if (!context.clientId || context.signal?.aborted) {
        throw new Error('runtime_unavailable')
      }
      const terminal = await resolveMobileWebTerminalTab(context, params.worktree, params.tabId)
      const action = actions.get(params.method)
      if (!action || isStreamingMethod(action)) {
        throw new Error('method_not_found')
      }
      // The handle comes from the host tab list, never from the request fields.
      const input = action.params!.parse({
        ...params.fields,
        terminal,
        client: { id: context.clientId, type: 'mobile' }
      })
      if (context.signal?.aborted || Date.now() >= deadline) {
        throw new Error('runtime_unavailable')
      }
      await action.handler(input, context)
      return { applied: true }
    }
  })
]
