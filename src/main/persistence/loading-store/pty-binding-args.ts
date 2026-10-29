import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'

export type PtyBindingSourceExpectation = {
  worktreeId?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
}

export type PtyBindingOrigin = 'reattach' | 'spawn' | 'relay_reattach' | 'split' | 'unknown'

export type PersistPtyBindingArgs = {
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
