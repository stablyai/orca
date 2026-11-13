import type { PtySpawnOperationState, PtySpawnExecutionFacts } from '../spawn-operation-state'
import { readTerminalSpawnDeferral } from '../../../../shared/terminal/pty/admission/spawn-admission-contract'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { ptyBindingIsRefused } from '../../../persistence/loading-store/terminal-bindings/pty-binding-refusals'
import { resolveStablePaneOwner } from './stable-owner'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import {
  parseAccountRestartReceipt,
  type AccountRestartCondition,
  type AccountRestartReceipt,
  type AccountRestartSnapshot
} from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'

export type AccountRestartOperation = {
  condition: AccountRestartCondition
  stop: AccountRestartReceipt['stop']
  original?: Extract<AccountRestartCondition['expected'], { kind: 'endpoint' }>
  outcomeUnknown?: true
}
const receiptKey = Symbol('accountRestartReceipt')
type RestartError = Error & { [receiptKey]?: AccountRestartReceipt }

export function accountRestartSnapshot(
  store: Store,
  runtime: OrcaRuntimeService | undefined,
  pane: AccountRestartCondition['pane'],
  connectionId?: string | null
): AccountRestartSnapshot {
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
  const session = store.getWorkspaceSession(hostId)
  const key = makePaneKey(pane.tabId, pane.leafId)
  if (
    ptyBindingIsRefused(
      { tabId: pane.tabId, leafId: pane.leafId, mayCreate: false, mayReviveRetiredSurface: false },
      session,
      pane.worktreeId,
      key,
      []
    )
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  const tab = session.tabsByWorktree[pane.worktreeId]?.find((t) => t.id === pane.tabId)
  if (!tab || tab.createdAt !== pane.tabCreatedAt) {
    throw new Error('terminal_pane_owner_changed')
  }
  const owner = resolveStablePaneOwner(runtime, store, key, pane.worktreeId, connectionId)
  if (owner && !owner.incarnationId) {
    throw new Error('terminal_pane_owner_unverified')
  }
  return {
    hostEpoch: store.getPtyBindingEpoch(),
    bindingGeneration: store.trackPtyBindingGeneration({ hostId, leafId: pane.leafId }),
    tabCreatedAt: tab.createdAt,
    owner: owner?.incarnationId ? { ptyId: owner.ptyId, incarnationId: owner.incarnationId } : null
  }
}

export function assertAccountRestartOwner(
  store: Store | undefined,
  runtime: OrcaRuntimeService | undefined,
  operation: AccountRestartOperation,
  connectionId?: string | null
): void {
  if (!store) {
    throw new Error('terminal_pane_owner_unverified')
  }
  const c = operation.condition
  const current = accountRestartSnapshot(store, runtime, c.pane, connectionId)
  if (
    current.hostEpoch !== c.hostEpoch ||
    current.bindingGeneration !== c.expected.bindingGeneration ||
    (c.expected.kind === 'empty'
      ? current.owner !== null
      : !current.owner ||
        current.owner.ptyId !== c.expected.ptyId ||
        current.owner.incarnationId !== c.expected.incarnationId)
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
}

export function stampAccountRestartFailure(
  error: unknown,
  operation: AccountRestartOperation,
  store: Store | undefined,
  runtime: OrcaRuntimeService | undefined,
  connectionId?: string | null
): Error {
  const receipt: AccountRestartReceipt = {
    v: 1,
    requestId: operation.condition.requestId,
    attemptId: operation.condition.attemptId,
    stop: operation.stop,
    outcome:
      operation.outcomeUnknown ||
      (error &&
        typeof error === 'object' &&
        'agentSessionOperationOutcome' in error &&
        error.agentSessionOperationOutcome === 'unknown')
        ? 'unknown'
        : 'terminal'
  }
  try {
    if (store) {
      const current = accountRestartSnapshot(store, runtime, operation.condition.pane, connectionId)
      const expected = operation.original ?? operation.condition.expected
      if (
        current.hostEpoch === operation.condition.hostEpoch &&
        (current.bindingGeneration === operation.condition.expected.bindingGeneration ||
          (operation.stop === 'confirmed-retired' &&
            current.owner &&
            expected.kind === 'endpoint' &&
            current.owner.ptyId === expected.ptyId &&
            current.owner.incarnationId === expected.incarnationId)) &&
        (!current.owner ||
          (expected.kind === 'endpoint' &&
            current.owner.ptyId === expected.ptyId &&
            current.owner.incarnationId === expected.incarnationId))
      ) {
        receipt.current = {
          kind: current.owner ? 'original' : 'empty',
          bindingGeneration: current.bindingGeneration,
          ...(current.owner ? { incarnationId: current.owner.incarnationId } : {})
        }
      }
    }
  } catch {
    /* Unknown ownership is not an empty-leaf proof. */
  }
  const wrapped: RestartError = new Error(error instanceof Error ? error.message : String(error))
  if (error instanceof Error) {
    Object.setPrototypeOf(wrapped, Object.getPrototypeOf(error))
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(error))
  }
  wrapped[receiptKey] = receipt
  return wrapped
}

export function accountRestartErrorReceipt(error: unknown): AccountRestartReceipt | undefined {
  return error instanceof Error && receiptKey in error
    ? parseAccountRestartReceipt(error[receiptKey])
    : undefined
}

export async function accountRestartBoundary<T>(
  condition: AccountRestartCondition | undefined,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!condition || accountRestartErrorReceipt(error)) {
      throw error
    }
    throw stampAccountRestartFailure(
      error,
      {
        condition,
        stop: readTerminalSpawnDeferral(error) ? 'not-started' : 'unknown',
        ...(readTerminalSpawnDeferral(error) ? {} : { outcomeUnknown: true })
      },
      undefined,
      undefined
    )
  }
}

export function beginAccountRestartOperation(
  condition: AccountRestartCondition
): AccountRestartOperation {
  return {
    condition,
    stop: 'not-started',
    ...(condition.expected.kind === 'endpoint' ? { original: condition.expected } : {})
  }
}

export function accountRestartExecutionFacts(
  state: PtySpawnOperationState,
  facts: PtySpawnExecutionFacts
): PtySpawnExecutionFacts {
  const operation = state.accountRestartOperation
  if (!operation) {
    return facts
  }
  return {
    ...facts,
    validateDispatch: () => {
      assertAccountRestartOwner(
        state.deps.store,
        state.deps.runtime,
        operation,
        state.args.connectionId
      )
      facts.validateDispatch?.()
    }
  }
}
