import { z } from 'zod'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { defineMethod, isStreamingMethod } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

const Scope = z.object({ worktree: z.string().min(1).max(4096) })
const createTerminal = SESSION_TAB_METHODS.find(
  (method) => method.name === 'session.tabs.createTerminal'
)
if (!createTerminal || isStreamingMethod(createTerminal)) {
  throw new Error('Missing terminal creation method')
}
const source = createTerminal
const Created = z.object({
  tab: z.object({ type: z.literal('terminal'), id: z.string().min(1).max(512) })
})

export const MOBILE_WEB_SESSION_TERMINAL_CREATION_METHODS = [
  defineMethod({
    name: 'mobileWeb.session.agentOptions',
    params: Scope,
    handler: async (params, { runtime }) => ({
      agents: await runtime.getMobileSessionAgentOptions(params.worktree)
    })
  }),
  defineMethod({
    name: 'mobileWeb.session.createTerminal',
    params: Scope.extend({
      agent: z.custom<TuiAgent>(isTuiAgent).optional(),
      clientMutationId: z.string().min(1).max(128),
      timeoutMs: z.number().int().min(1).max(15_000)
    }),
    handler: async (params, context) => {
      const deadline = Date.now() + params.timeoutMs
      const checkDispatch = () => {
        if (context.signal?.aborted || Date.now() >= deadline) {
          throw new Error('runtime_unavailable')
        }
      }
      checkDispatch()
      if (
        params.agent &&
        !(await context.runtime.getMobileSessionAgentOptions(params.worktree)).includes(
          params.agent
        )
      ) {
        throw new Error('invalid_params')
      }
      checkDispatch()
      const result = await source.handler(
        source.params!.parse({
          worktree: params.worktree,
          agent: params.agent,
          clientMutationId: params.clientMutationId,
          activate: true,
          select: true,
          navigation: 'caller'
        }),
        context
      )
      // Only the already-public tab identity crosses the page boundary.
      return { tabId: Created.parse(result).tab.id, created: true }
    }
  })
]
