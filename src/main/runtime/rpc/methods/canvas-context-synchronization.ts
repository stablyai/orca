import {
  canvasContextSyncSchema,
  type CanvasContextIdentity,
  type CanvasContextReceipt
} from '../../../../shared/canvas-agent-context'
import { agentHookServer } from '../../../agent-hooks/server'
import { refreshCanvasMessaging } from '../../canvas/canvas-messaging-runtime'
import { defineMethod } from '../core'
import { resolveCanvasContextIdentity } from './canvas-context-terminal-identity'

export const CANVAS_CONTEXT_SYNC_METHOD = defineMethod({
  name: 'agentHooks.canvasContextSync',
  params: canvasContextSyncSchema,
  handler: async (params, { runtime }) => {
    const identities = new Map<string, CanvasContextIdentity | null>()
    const statuses: CanvasContextReceipt['nodes'] = {}
    const deferred = [...params.deferredBindings]
    const bindings = params.bindings.filter((binding) => {
      try {
        const result = resolveCanvasContextIdentity(runtime, binding)
        if (result === 'unsupported') {
          statuses[binding.nodeId] = { state: 'unsupported', provider: binding.provider }
          deferred.push({ ...binding, notes: [], peers: [], collaborationPaused: true })
          return false
        }
        identities.set(binding.nodeId, result)
        return true
      } catch {
        statuses[binding.nodeId] = { state: 'unverifiable', provider: binding.provider }
        deferred.push(binding)
        return false
      }
    })
    const result = await agentHookServer.canvasContexts.replace(
      { ...params, bindings },
      identities,
      deferred
    )
    for (const binding of deferred) {
      const previous = result.nodes[binding.nodeId]
      if (previous && !statuses[binding.nodeId]) {
        statuses[binding.nodeId] = { ...previous, state: 'unverifiable' }
      }
    }
    refreshCanvasMessaging(
      runtime,
      [...bindings, ...deferred].some((binding) => binding.peers?.length)
    )
    return { ...result, nodes: { ...result.nodes, ...statuses } }
  }
})
