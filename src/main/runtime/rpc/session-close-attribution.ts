import { withSpan } from '../../observability/tracer'
import type { RpcContext } from './core'

// Why: a production incident (#8871) killed host PTYs via close/kill RPCs with
// no record of who requested it. Wrap the close in a persisted span so the trace
// attributes the issuing device AND records the real outcome (Success/Failure).
// SECURITY: log the non-sensitive device.deviceId only — never ctx.clientId,
// which is the device's bearer token.
export function recordSessionCloseAttribution<T>(
  method: string,
  ctx: Pick<RpcContext, 'clientKind' | 'deviceId' | 'connectionId'>,
  target: { worktree: string; tabId: string },
  run: () => Promise<T> | T
): Promise<T> {
  return withSpan(method, run, {
    kind: 'client',
    attributes: {
      attribution: 'session-close',
      clientKind: ctx.clientKind ?? 'in-process',
      deviceId: ctx.deviceId ?? 'in-process',
      connectionId: ctx.connectionId ?? 'in-process',
      worktreeId: target.worktree,
      tabId: target.tabId
    }
  })
}
