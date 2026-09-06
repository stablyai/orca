import {
  canvasContextReplaceSchema,
  type CanvasContextIdentity,
  type CanvasContextReceipt
} from '../../../../shared/canvas-agent-context'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { agentHookServer } from '../../../agent-hooks/server'
import { defineMethod } from '../core'
import { refreshCanvasMessaging } from '../../canvas/canvas-messaging-runtime'

export const CANVAS_AGENT_CONTEXT_METHODS = [
  defineMethod({
    name: 'agentHooks.canvasContext',
    params: canvasContextReplaceSchema,
    handler: async (params, { runtime }) => {
      const identities = new Map<string, CanvasContextIdentity | null>()
      const unsupported: CanvasContextReceipt['nodes'] = {}
      const bindings = params.bindings.filter((binding) => {
        const terminal = runtime.resolveTerminalPane(binding.paneKey, binding.worktreeId)
        if (
          terminal.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
          !runtime.getClientSettings().agentStatusHooksEnabled ||
          runtime.getClientSettings().disabledTuiAgents.includes(binding.provider)
        ) {
          unsupported[binding.nodeId] = { state: 'unsupported', provider: binding.provider }
          return false
        }
        if (
          terminal.ptyId !== binding.ptyId ||
          runtime.resolveLiveLeafForHandle(terminal.handle)?.ptyId !== binding.ptyId
        ) {
          throw new Error('The terminal session changed. Reconnect the note.')
        }
        const authority = agentHookServer
          .getCurrentAuthorityObservations()
          .find(
            (entry) =>
              entry.paneKey === binding.paneKey &&
              entry.connectionId === null &&
              entry.worktreeId === binding.worktreeId
          )
        const observed = agentHookServer.canvasContexts.identity(
          binding.paneKey,
          binding.provider,
          binding.worktreeId
        )
        const launch = runtime.getOrchestrationDispatchAuthority(terminal.handle)
        const launchTokenHash =
          launch?.ptyId === binding.ptyId && launch.worktreeId === binding.worktreeId
            ? (launch.launchTokenHash ?? authority?.launchTokenHash)
            : authority?.launchTokenHash
        identities.set(
          binding.nodeId,
          launchTokenHash
            ? {
                sessionId: observed?.launchTokenHash === launchTokenHash ? observed.sessionId : '',
                launchTokenHash
              }
            : null
        )
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
  })
]
