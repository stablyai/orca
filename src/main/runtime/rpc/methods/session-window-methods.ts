import { z } from 'zod'
import { isStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'

export function sessionWindowMethods(methods: readonly RpcAnyMethod[]): RpcAnyMethod[] {
  return methods
    .filter(
      (method) =>
        method.name.startsWith('session.tabs.') &&
        !['session.tabs.close', 'session.tabs.move', 'session.tabs.updatePaneLayout'].includes(
          method.name
        )
    )
    .map((method) => {
      const params = z.object({
        windowId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9-]+$/),
        params: method.params ?? z.unknown().optional()
      })
      const scopedContext = (context: RpcContext, windowId: string): RpcContext => {
        if (!context.pairedDeviceId) {
          throw new Error('workspace_window_requires_paired_device')
        }
        return {
          ...context,
          clientNavigationId: `${context.pairedDeviceId}:window:${windowId}`,
          subscriptionNamespace: `${context.connectionId ?? 'local'}:window:${windowId}`
        }
      }
      const name = method.name.replace('session.tabs.', 'session.window.tabs.')
      if (isStreamingMethod(method)) {
        return {
          name,
          params,
          stream: true as const,
          handler: async (value, context, emit) => {
            const args = params.parse(value)
            return method.handler(args.params, scopedContext(context, args.windowId), emit)
          }
        }
      }
      return {
        name,
        params,
        handler: (value, context) => {
          const args = params.parse(value)
          return method.handler(args.params, scopedContext(context, args.windowId))
        }
      }
    })
}
