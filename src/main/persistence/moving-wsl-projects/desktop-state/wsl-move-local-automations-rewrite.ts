/**
 * After a WSL move commits, the copies here of the automations the host now runs turn off: the
 * scheduler skips them anyway, and an "on" copy beside the host's reads as a second live one.
 * Undo gives them the host's state back (wsl-move-undo-host-automations.ts).
 */
import type { Store } from '../../loading-store/store'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'

export const WSL_MOVE_LOCAL_AUTOMATIONS_STORE_ID = 'local-automations'

export type WslMoveLocalAutomationsProfile = Pick<
  Store,
  'disableAutomations' | 'flushPendingOrThrowAsync'
>

export function registerWslMoveLocalAutomationsStore(
  profile: WslMoveLocalAutomationsProfile
): void {
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_LOCAL_AUTOMATIONS_STORE_ID,
    side: 'main',
    run: ({ cutover }) => {
      // Only the ones that were on here: the rest are already off, and undo reads them from the host.
      const ids = cutover.automationsToReenable ?? []
      if (ids.length > 0) {
        profile.disableAutomations(new Set(ids))
      }
    },
    flush: () => profile.flushPendingOrThrowAsync()
  })
}
