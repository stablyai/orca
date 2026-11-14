import type { AccountRestartOperation } from './account-restart-owner'
import type { AccountRestartCondition } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import type { PtyRetirementEvidence } from '../../../pty/process-retirement/pty-exit-proof'
import { PtyExitProof } from '../../../pty/process-retirement/pty-exit-proof'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { Store } from '../../../persistence/loading-store/store'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/terminal-bindings/pty-binding-persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { ReplacedPaneOwner } from './replaced-pane-owner'
import { resolveStablePaneOwner } from './stable-owner'

/** Caller holds the pane's spawn reservation, so no other spawn can claim the pane meanwhile. */
export async function stopReplacedPaneOwner(
  deps: {
    runtime?: OrcaRuntimeService
    store?: Store
    stopReplacedPty: (id: string) => Promise<PtyRetirementEvidence | void>
  },
  args: {
    requireProof?: boolean
    replacesPtyId: string
    paneKey: string | null
    worktreeId: string | undefined
    connectionId: string | null | undefined
  }
): Promise<ReplacedPaneOwner> {
  const owner = resolveStablePaneOwner(
    deps.runtime,
    deps.store,
    args.paneKey,
    args.worktreeId,
    args.connectionId
  )
  if (owner && owner.ptyId !== args.replacesPtyId) {
    throw new Error('terminal_pane_owner_changed')
  }
  const evidence = await deps.stopReplacedPty(args.replacesPtyId)
  if (args.requireProof && !(evidence instanceof PtyExitProof)) {
    throw new Error('terminal_replaced_pty_stop_unverified')
  }
  const pane = args.paneKey ? parsePaneKey(args.paneKey) : null
  return {
    ptyId: args.replacesPtyId,
    pane:
      pane && args.worktreeId
        ? {
            worktreeId: args.worktreeId,
            tabId: pane.tabId,
            leafId: pane.leafId,
            hostId: args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
          }
        : null
  }
}

/** Swap inside the durable mutation: accept the stopped ID or a renderer-cleared leaf; another owner wins. */
export function swapReplacedPaneBinding(
  store: Store,
  binding: PersistPtyBindingArgs,
  replaced: ReplacedPaneOwner
): () => PersistPtyBindingArgs | null {
  return () => {
    const bound =
      store.getWorkspaceSession().terminalLayoutsByTabId?.[binding.tabId]?.ptyIdsByLeafId?.[
        binding.leafId
      ]
    // Unbound is ok: the renderer's pre-connect clear can withdraw it (split tab).
    if (bound !== undefined && bound !== replaced.ptyId) {
      return null
    }
    return replaced.dropsIncarnation ? { ...binding, dropsIncarnation: true } : binding
  }
}

/** Clears a stopped id's binding and keeps the pane; false when another owner took the pane. */
export async function retireReplacedPaneBinding(
  store: Store,
  replaced: ReplacedPaneOwner & {
    pane: NonNullable<ReplacedPaneOwner['pane']>
    /** Also fence on the saved incarnation, for an id the host reported absent rather than stopped. */
    absenceFence?: {
      incarnationId: string | undefined
      onRetired?: (generation: number) => void
      accountRestart?: AccountRestartCondition
    }
  }
): Promise<boolean> {
  const { hostId, ...pane } = replaced.pane
  return store.retirePtyBinding({ ...pane, ptyId: replaced.ptyId }, hostId, replaced.absenceFence)
}

/** Best effort: a failed replacement must not leave the stopped id bound for the remount to reattach. */
export async function releaseStoppedPaneBinding(
  store: Store | undefined,
  replaced: ReplacedPaneOwner,
  operation?: AccountRestartOperation
): Promise<boolean> {
  if (!store || !replaced.pane) {
    return false
  }
  try {
    return await retireReplacedPaneBinding(store, {
      ...replaced,
      pane: replaced.pane,
      ...(operation
        ? {
            absenceFence: {
              incarnationId:
                operation.condition.expected.kind === 'endpoint'
                  ? operation.condition.expected.incarnationId
                  : undefined,
              accountRestart: operation.condition,
              onRetired: (generation: number) => {
                operation.condition = {
                  ...operation.condition,
                  expected: { kind: 'empty', bindingGeneration: generation }
                }
              }
            }
          }
        : {})
    })
  } catch (error) {
    console.warn('[pty] could not clear the stopped pane binding after a failed restart:', error)
    return false
  }
}
