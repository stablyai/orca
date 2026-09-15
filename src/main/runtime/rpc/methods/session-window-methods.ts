import { z } from 'zod'
import type { RpcAnyMethodDeclaration, RpcContext } from '../core'

export type SessionWindowMethodDeclaration = RpcAnyMethodDeclaration & {
  readonly name: `session.window.tabs.${string}`
}

export function sessionWindowMethods(
  methods: readonly RpcAnyMethodDeclaration[]
): SessionWindowMethodDeclaration[] {
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
      const handler = method.handler as unknown as (
        params: unknown,
        context: RpcContext,
        emit?: (result: unknown) => void
      ) => unknown
      if ('stream' in method && method.stream === true) {
        return {
          name,
          params,
          stream: true as const,
          handler: async (value: never, context, emit) => {
            const args = params.parse(value)
            return handler(
              args.params,
              scopedContext(context, args.windowId),
              emit
            ) as Promise<void>
          }
        } as SessionWindowMethodDeclaration
      }
      return {
        name,
        params,
        handler: (value: never, context) => {
          const args = params.parse(value)
          return handler(args.params, scopedContext(context, args.windowId))
        }
      } as SessionWindowMethodDeclaration
    })
}
