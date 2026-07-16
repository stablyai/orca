import type { RuntimeCloseIntent } from '../../../shared/runtime-close-intent'
import { withSpan } from '../../observability/tracer'
import type { RpcContext } from './core'
import type { RuntimeCloseDecision, RuntimeCloseTarget } from './runtime-close-policy'

// Why: a production incident (#8871) killed host PTYs via close/kill RPCs with
// no record of who requested it. Persist both allowed and blocked decisions so
// support traces identify the issuing device without exposing its bearer token.
export function recordRuntimeCloseAttribution<T>(
  method: string,
  ctx: Pick<RpcContext, 'clientKind' | 'deviceId' | 'connectionId'>,
  target: RuntimeCloseTarget,
  intent: RuntimeCloseIntent | undefined,
  decision: RuntimeCloseDecision,
  run: () => Promise<T> | T
): Promise<T> {
  return withSpan(method, run, {
    kind: 'client',
    attributes: {
      attribution: 'runtime-close',
      clientKind: ctx.clientKind ?? 'in-process',
      deviceId: ctx.deviceId ?? 'in-process',
      connectionId: ctx.connectionId ?? 'in-process',
      targetKind: target.kind,
      worktreeId: target.kind === 'session-tab' ? target.worktree : 'unknown',
      tabId:
        target.kind === 'session-tab'
          ? target.tabId
          : (intent?.hostTabId ?? intent?.clientTabId ?? 'unknown'),
      terminal: target.kind === 'session-tab' ? 'unknown' : target.terminal,
      decision: decision.allowed ? 'allowed' : 'blocked',
      decisionReason: decision.reason,
      recentlyAttached: decision.recentlyAttached,
      closeSource: intent?.source ?? 'legacy',
      closeRequestId: intent?.requestId ?? 'legacy'
    }
  })
}
