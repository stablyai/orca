import {
  canvasContextReplaceSchema,
  type CanvasContextIdentity,
  type CanvasContextReceipt
} from '../../../../shared/canvas-agent-context'
import { agentHookServer } from '../../../agent-hooks/server'
import { defineMethod } from '../core'
import { refreshCanvasMessaging } from '../../canvas/canvas-messaging-runtime'
import { resolveCanvasContextIdentity } from './canvas-context-terminal-identity'
import { CANVAS_CONTEXT_SYNC_METHOD } from './canvas-context-synchronization'

export const CANVAS_AGENT_CONTEXT_METHODS = [
  defineMethod({
    name: 'agentHooks.canvasContext',
    params: canvasContextReplaceSchema,
    handler: async (params, { runtime }) => {
      const identities = new Map<string, CanvasContextIdentity | null>()
      const unsupported: CanvasContextReceipt['nodes'] = {}
      const bindings = params.bindings.filter((binding) => {
        const identity = resolveCanvasContextIdentity(runtime, binding)
        if (identity === 'unsupported') {
          unsupported[binding.nodeId] = { state: 'unsupported', provider: binding.provider }
          return false
        }
        identities.set(binding.nodeId, identity)
        return true
      })
      const result = await agentHookServer.canvasContexts.replace(
        { ...params, bindings },
        identities
      )
      refreshCanvasMessaging(
        runtime,
        bindings.some((binding) => binding.peers?.length)
      )
      return { ...result, nodes: { ...result.nodes, ...unsupported } }
    }
  }),
  CANVAS_CONTEXT_SYNC_METHOD
] as const
