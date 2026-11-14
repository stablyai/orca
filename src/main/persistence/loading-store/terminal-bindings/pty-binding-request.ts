import type { StoreRuntimeState } from '../store-runtime-state'
import type { AccountRestartCondition } from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import type { PtyBindingSourceExpectation } from '../store'
import type { PtyBindingOrigin } from './pty-binding-span'
import type { TerminalPanePlacement } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-placement'

export type PersistPtyBindingArgs = {
  accountRestart?: AccountRestartCondition
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  startupCwd?: string
  correctStartupCwd?: string
  expectedBinding?: { ptyId: string; incarnationId?: string }
  expectedSourceBinding?: PtyBindingSourceExpectation
  /** Spawns may precede layout saves; reattach must disable creation once absence proves a user close. */
  mayCreate?: boolean
  mayReviveRetiredSurface?: boolean
  /** Tracing metadata only; persistence must not branch on origin. */
  origin?: PtyBindingOrigin
  /** Report-only until main owns layout; then determines split placement. */
  placement?: TerminalPanePlacement
  /** Replacement without incarnationId clears the saved incarnation. */
  dropsIncarnation?: true
}

export type PtyBindingPersistenceOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'runDurableMutation'
  | 'lastDurableWriteGeneration'
  | 'pendingWrite'
  | 'quitFlushStarted'
  | 'dirtyProfileStateDomains'
  | 'state'
  | 'writeGeneration'
  | 'writeTimer'
  | 'ptyBindingGenerations'
  | 'ptyBindingGenerationSequence'
  | 'workspaceMetadataCursor'
>
