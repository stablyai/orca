import { randomUUID } from 'node:crypto'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../../persistence/restoring-sessions/workspace-session-write-rollback'
import type { RuntimeStore } from '../runtime-store-contract'

/** A switch's change while it is the chat's current one. */
type UnsavedSwitch = { command: CommandOf<'setTabContent'>; current: () => boolean }

/** At most this many: a window saves its tabs within seconds, so only the last few can be unsaved. */
const UNSAVED_SWITCH_LIMIT = 8

/**
 * Switches a window applied, or may have (its answer lost), that its debounced save may not hold
 * yet. When a new page of the same main loads (a reload), it reads the saved tabs, which could
 * still show the switch's source: each switch still current is written into the saved layout
 * then, exactly (the tab must still hold just the source, else nothing changes), and that page
 * reads those workspaces again. Main's own layout never needs this: its writes are saved as they
 * apply. An entry ends when a new page takes it (applied, already there, or the tab changed),
 * when a newer switch of the same tab or the oldest-first limit replaces it, when it is no longer
 * current, or when main exits. It holds no command: the switch already ended.
 */
export class UnsavedWindowSwitches {
  private readonly entries = new Map<string, UnsavedSwitch>()

  private note(command: CommandOf<'setTabContent'>, current: () => boolean): void {
    const key = `${command.workspace}\n${command.tabId}`
    this.entries.delete(key)
    this.entries.set(key, { command, current })
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= UNSAVED_SWITCH_LIMIT) {
        break
      }
      this.entries.delete(oldest)
    }
  }

  /** Keeps a window's change that applied, or may have (unknown), for the switch it settles. */
  keeping<T extends { kind: string }>(
    windowOwned: boolean,
    target: Omit<CommandOf<'setTabContent'>, 'type' | 'content'>,
    content: CommandOf<'setTabContent'>['content'],
    current: () => boolean
  ): (settlement: T) => T {
    return (settlement) => {
      if (windowOwned && (settlement.kind === 'applied' || settlement.kind === 'unknown')) {
        this.note({ type: 'setTabContent', ...target, content }, current)
      }
      return settlement
    }
  }

  /** Writes the current ones into the saved layout in one checked write; answers the workspaces
   *  it changed. */
  async replay(store: RuntimeStore | null | undefined): Promise<string[]> {
    const pending = [...this.entries.values()].filter((entry) => entry.current())
    this.entries.clear()
    if (
      pending.length === 0 ||
      !store?.getWorkspaceSession ||
      !store.setWorkspaceSession ||
      !store.runDurableMutation
    ) {
      return []
    }
    const { getWorkspaceSession, setWorkspaceSession } = store
    const changed = new Set<string>()
    await store.runDurableMutation(() => {
      const session = getWorkspaceSession.call(store, LOCAL_EXECUTION_HOST_ID)
      if (!session) {
        return { value: undefined, persist: false }
      }
      const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, nameBasedLoadContext())
      let layout = loaded.layout
      for (const { command } of pending) {
        const applied = layout.workspaces[command.workspace]
          ? applyLayoutCommand(layout, command, {
              mintId: randomUUID,
              mintLeafId: randomUUID,
              now: Date.now
            })
          : null
        if (applied?.ok && applied.model !== layout) {
          layout = applied.model
          changed.add(command.workspace)
        }
      }
      if (changed.size === 0) {
        return { value: undefined, persist: false }
      }
      const next = saveWorkspaceLayout({ ...loaded, layout })
      setWorkspaceSession.call(store, next, LOCAL_EXECUTION_HOST_ID)
      return {
        value: undefined,
        rollback: () => {
          const current = getWorkspaceSession.call(store, LOCAL_EXECUTION_HOST_ID)
          if (current) {
            setWorkspaceSession.call(
              store,
              rollbackWorkspaceSessionAfterFailedAsyncWrite(session, next, current),
              LOCAL_EXECUTION_HOST_ID
            )
          }
        }
      }
    })
    return [...changed]
  }
}
