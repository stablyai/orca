import { withSpan } from '../../observability/tracer'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeTerminalClose } from '../../../shared/runtime-types'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { reconcileTerminalCloseIntent } from '../terminal-close-intent-reconciliation'
import { OrchestrationError } from '../orchestration/orchestration-error'
import type { RpcContext } from './core'

type TerminalCloseMethod = 'terminal.close' | 'terminal.closeTab'
type TerminalCloseTargetKind = 'terminal' | 'terminal-tab'

export function withTerminalCloseAttribution(
  method: TerminalCloseMethod,
  context: Pick<
    RpcContext,
    | 'runtime'
    | 'clientKind'
    | 'pairedDeviceId'
    | 'connectionId'
    | 'requestId'
    | 'authenticatedCallerFingerprint'
  >,
  targetKind: TerminalCloseTargetKind,
  terminal: string,
  close: () => Promise<RuntimeTerminalClose>
): Promise<RuntimeTerminalClose> {
  return withSpan(
    method,
    async (span) => {
      span.setAttribute('decision', 'allowed')
      try {
        const result = supportsDurableClose(context.runtime)
          ? await closeWithDurableIntent(method, context, targetKind, terminal, close)
          : await close()
        span.setAttribute('outcome', 'succeeded')
        span.setAttribute('tabId', result.tabId)
        span.setAttribute('ptyKilled', result.ptyKilled)
        if (result.closeMode) {
          span.setAttribute('closeMode', result.closeMode)
        }
        return result
      } catch (error) {
        span.setAttribute('outcome', 'failed')
        throw error
      }
    },
    {
      kind: 'client',
      attributes: {
        attribution: 'terminal-close',
        runtimeId: context.runtime.getRuntimeId(),
        origin: context.clientKind ?? 'in-process',
        deviceId: context.pairedDeviceId ?? 'in-process',
        connectionGeneration: context.connectionId ?? 'in-process',
        requestId: context.requestId ?? 'in-process',
        targetKind,
        terminal
      }
    }
  )
}

function supportsDurableClose(runtime: RpcContext['runtime']): boolean {
  return (
    typeof runtime.getOrchestrationDb === 'function' &&
    typeof runtime.showTerminal === 'function' &&
    typeof runtime.getTerminalProcessIncarnation === 'function'
  )
}

async function closeWithDurableIntent(
  method: TerminalCloseMethod,
  context: Pick<
    RpcContext,
    | 'runtime'
    | 'clientKind'
    | 'pairedDeviceId'
    | 'connectionId'
    | 'requestId'
    | 'authenticatedCallerFingerprint'
  >,
  targetKind: TerminalCloseTargetKind,
  terminalHandle: string,
  close: () => Promise<RuntimeTerminalClose>
): Promise<RuntimeTerminalClose> {
  const db = context.runtime.getOrchestrationDb()
  const replay = context.requestId ? db.getTerminalCloseIntent(context.requestId) : undefined
  if (replay) {
    if (
      replay.terminalHandle !== terminalHandle ||
      replay.targetKind !== targetKind ||
      replay.ownerPrincipal !== resolveOwnerPrincipal(context)
    ) {
      throw new OrchestrationError(
        'mutation_conflict',
        `Close mutation ${replay.mutationId} is already bound to another identity.`
      )
    }
    return reconcileTerminalCloseIntent({ runtime: context.runtime, intent: replay, close })
  }
  const terminal = await context.runtime.showTerminal(terminalHandle)
  const ptyIncarnation = context.runtime.getTerminalProcessIncarnation(terminalHandle)
  if (!terminal.ptyId || !ptyIncarnation) {
    throw new Error(`terminal_close_identity_unverifiable: ${terminalHandle}`)
  }
  const executionHostId = normalizeExecutionHostId(terminal.executionHostId)
  if (!executionHostId || !terminal.worktreeId) {
    throw new Error(`terminal_close_identity_unverifiable: ${terminalHandle}`)
  }
  const workspaceKey = parseWorkspaceKey(terminal.worktreeId)
    ? terminal.worktreeId
    : worktreeWorkspaceKey(terminal.worktreeId)
  const mutationId =
    context.requestId ??
    `${method}:${context.connectionId ?? 'in-process'}:${terminalHandle}:${ptyIncarnation}`
  const intent = db.reserveTerminalCloseIntent({
    mutationId,
    executionHostId,
    workspaceKey,
    terminalHandle,
    targetKind,
    ptyIncarnation,
    processRootId: terminal.ptyId,
    ownerPrincipal: resolveOwnerPrincipal(context),
    reason: 'user-close'
  })
  return reconcileTerminalCloseIntent({ runtime: context.runtime, intent, close })
}

function resolveOwnerPrincipal(
  context: Pick<RpcContext, 'authenticatedCallerFingerprint' | 'pairedDeviceId' | 'clientKind'>
): string {
  return (
    context.authenticatedCallerFingerprint ??
    context.pairedDeviceId ??
    context.clientKind ??
    'in-process'
  )
}
