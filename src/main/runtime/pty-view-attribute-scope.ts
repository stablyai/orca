import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type {
  RuntimeHeadlessTerminal,
  RuntimePtyWorktreeRecord
} from './terminal/records/runtime-terminal-state-records'
import { inferWorktreeIdFromPtyId } from './workspaces/catalog/runtime-worktree-path-identity'
import {
  getTerminalViewAttributesForScope,
  registerTerminalViewAttributesApplier,
  type TerminalViewAttributeScope
} from './terminal/view/terminal-view-attribute-store'

/** View-attribute scope for one PTY. Why the id fallbacks: live daemon bytes
 *  can create the emulator before renderer graph sync records the worktree. */
export function resolvePtyViewAttributeScope(
  ptyId: string,
  record: Pick<RuntimePtyWorktreeRecord, 'worktreeId' | 'connectionId'> | undefined
): TerminalViewAttributeScope {
  return {
    worktreeId: record?.worktreeId ?? inferWorktreeIdFromPtyId(ptyId),
    connectionId: record?.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
  }
}

/** Why: a renderer attribute push must reach already-live emulators too —
 *  cursor options for DECRQSS/DECRQM parity plus the per-PTY OSC color
 *  override reset a theme apply implies (terminal-query-authority.md
 *  §View-attribute bridge). Each PTY resolves its own repo-or-global
 *  snapshot before and after the push, so only PTYs whose palette a theme
 *  change moved lose their OSC SET overlays — never one whose base main
 *  merely learned (late worktree registration, first map arrival). */
export function registerScopedTerminalViewAttributesApplier(
  headlessTerminals: ReadonlyMap<string, RuntimeHeadlessTerminal>,
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>
): void {
  registerTerminalViewAttributesApplier((push) => {
    for (const [ptyId, state] of headlessTerminals) {
      const scope = resolvePtyViewAttributeScope(ptyId, ptysById.get(ptyId))
      const attributes = getTerminalViewAttributesForScope(scope)
      if (attributes) {
        state.emulator.applyPushedViewAttributes(
          attributes,
          push.kind === 'theme-change' ? push.resolveBefore(scope) : null
        )
      }
    }
  })
}
