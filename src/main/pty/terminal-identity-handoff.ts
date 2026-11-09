import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { LegacyTerminalIdentityClaims } from '../persistence/loading-store/legacy-terminal-identity-claims'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'
import { transferLegacyTerminalRestores } from './legacy-terminal-restore-ownership'
import { transferSelectedTerminal } from './selected-terminal-retirement'
import {
  makePaneSpawnReservationKey,
  movePaneSpawnReservations
} from '../ipc/pty/pane/spawn-reservation'

type Occupant = {
  workspace: string
  tabId: string
  leafId: string
  id: string
  incarnation?: string
}

/** Reuse the admitted membership traversal; UUID equality alone never proves a move. */
export class TerminalIdentityHandoff {
  private readonly before = new Map<string, Occupant | null>()
  private readonly after = new Map<string, Occupant | null>()
  readonly retained = new Set<string>()

  observe(
    side: 'before' | 'after',
    workspace: string,
    tabId: string,
    session: WorkspaceSessionState
  ): void {
    workspace = normalizeWorkspaceSessionKeyToWorkspaceId(workspace)
    const entries = this[side]
    const layout = session.terminalLayoutsByTabId?.[tabId]
    const visit = (node: NonNullable<typeof layout>['root']): void => {
      if (!node) {
        return
      }
      if (node.type !== 'leaf') {
        visit(node.first)
        visit(node.second)
        return
      }
      const leafId = node.leafId
      const id = layout?.ptyIdsByLeafId?.[leafId]
      if (!id) {
        return
      }
      const key = JSON.stringify([workspace, leafId])
      entries.set(
        key,
        entries.has(key)
          ? null
          : {
              workspace,
              tabId,
              leafId,
              id,
              incarnation: session.terminalPtyIncarnationsByPaneKey?.[makePaneKey(tabId, leafId)]
            }
      )
    }
    visit(layout?.root ?? null)
  }

  apply(authority: LegacyTerminalIdentityClaims): () => void {
    const undos: (() => void)[] = []
    for (const [key, source] of this.before) {
      const target = this.after.get(key)
      if (
        !source ||
        !target ||
        source.tabId === target.tabId ||
        source.id !== target.id ||
        source.incarnation !== target.incarnation ||
        !authority.isLocalWorkspace(source.workspace)
      ) {
        continue
      }
      const from = makePaneKey(source.tabId, source.leafId)
      const to = makePaneKey(target.tabId, target.leafId)
      const claimUndo = authority.transfer(source.workspace, from, to)
      // N must have an admitted claimant; scoped terminals may have no legacy admission.
      if (/^\d+$/.test(source.id) && !claimUndo) {
        continue
      }
      if (claimUndo) {
        undos.push(claimUndo)
      }
      undos.push(
        transferSelectedTerminal(
          authority,
          source.workspace,
          from,
          to,
          source.id,
          source.incarnation
        )
      )
      undos.push(
        transferLegacyTerminalRestores(
          authority,
          source.workspace,
          source.tabId,
          target.tabId,
          source.leafId,
          source.id,
          source.incarnation
        )
      )
      undos.push(
        movePaneSpawnReservations(
          makePaneSpawnReservationKey(source.workspace, null, from)!,
          makePaneSpawnReservationKey(source.workspace, null, to)!
        )
      )
      this.retained.add(from)
    }
    return () => {
      for (const undo of undos.toReversed()) {
        undo()
      }
    }
  }
}
