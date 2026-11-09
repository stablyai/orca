import { selectedTerminalForPane } from './selected-terminal-retirement'
import type { LegacyTerminalIdentityClaims } from '../persistence/loading-store/legacy-terminal-identity-claims'
import { LocalPtyProvider } from '../providers/local-pty/local-pty-provider'
import { preserveFencedTerminalHistory } from './pty-history-preserving-termination'
import type { TerminalTab } from '../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { IPtyProvider, PtySpawnResult } from '../providers/pty-provider-contract'
import { ptyIncarnationById, ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { finishPtyShutdown } from '../ipc/pty/provider/liveness'
import { PtyExitProof } from './process-retirement/pty-exit-proof'
import type { PtyFencedTerminationRequest } from '../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import {
  closeLegacyTerminalRestores,
  markLegacyTerminalStopUnverifiable
} from './legacy-terminal-restore-ownership'

export async function retireScopedTerminal(
  provider: IPtyProvider,
  result: Pick<PtySpawnResult, 'id' | 'incarnationId'>
): Promise<void> {
  if (result.incarnationId && provider instanceof LocalPtyProvider) {
    await provider.shutdown(result.id, {
      immediate: true,
      keepHistory: true,
      expectedIncarnationId: result.incarnationId
    })
    finishPtyShutdown(
      result.id,
      null,
      undefined,
      PtyExitProof.from('shutdown-acknowledged', result.incarnationId)
    )
    return
  }
  if (!result.incarnationId || !provider.killFenced) {
    throw new Error('Cannot verify the closed terminal incarnation')
  }
  const request: PtyFencedTerminationRequest = {
    id: result.id,
    expectedIncarnationId: result.incarnationId,
    requireNoAgentOwner: false,
    requireUnattached: false
  }
  preserveFencedTerminalHistory(request)
  const verdict = await provider.killFenced(request)
  if (verdict.outcome === 'refused') {
    if (verdict.reason === 'replaced') {
      return
    }
    throw new Error(`Closed terminal stop is ${verdict.reason}`)
  }
  finishPtyShutdown(
    result.id,
    null,
    undefined,
    PtyExitProof.from('shutdown-acknowledged', result.incarnationId)
  )
}

/** Called by the admitted snapshot's existing membership traversal, before binding publication. */
export function retireRemovedScopedTerminalRow(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  row: Pick<TerminalTab, 'id'>,
  prior: WorkspaceSessionState,
  next: WorkspaceSessionState,
  tabSurvives: boolean,
  retainedLeaves?: ReadonlySet<string>
): void {
  if (!authority.isLocalWorkspace(workspace)) {
    return
  }
  const oldLayout = prior.terminalLayoutsByTabId?.[row.id]
  const newLayout = next.terminalLayoutsByTabId?.[row.id]
  if (!tabSurvives && !oldLayout?.root) {
    closeLegacyTerminalRestores(authority, workspace, { kind: 'tab', tabId: row.id })
  }
  if (tabSurvives && oldLayout?.root === newLayout?.root) {
    return
  }
  const present = new Set<string>()
  const collect = (node: NonNullable<typeof newLayout>['root']): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      present.add(node.leafId)
    } else {
      collect(node.first)
      collect(node.second)
    }
  }
  if (tabSurvives) {
    collect(newLayout?.root ?? null)
  }
  const retire = (node: NonNullable<typeof oldLayout>['root']): void => {
    if (!node) {
      return
    }
    if (node.type !== 'leaf') {
      retire(node.first)
      retire(node.second)
      return
    }
    const leafId = node.leafId
    if (present.has(leafId) || retainedLeaves?.has(makePaneKey(row.id, leafId))) {
      return
    }
    closeLegacyTerminalRestores(authority, workspace, { kind: 'pane', tabId: row.id, leafId })
    const id = oldLayout?.ptyIdsByLeafId?.[leafId]
    if (!id || /^\d+$/.test(id)) {
      return
    }
    const incarnationId = prior.terminalPtyIncarnationsByPaneKey?.[makePaneKey(row.id, leafId)]
    if (!incarnationId) {
      return
    }
    try {
      const selected = selectedTerminalForPane(
        authority,
        workspace,
        makePaneKey(row.id, leafId),
        id,
        incarnationId
      )
      if (!selected || ptyIncarnationById.get(id) !== incarnationId) {
        return
      }
      void retireScopedTerminal(selected.provider, selected.result).catch((error: unknown) => {
        if (ptyOwnership.has(id) && ptyIncarnationById.get(id) === incarnationId) {
          markLegacyTerminalStopUnverifiable(
            authority,
            id,
            'closed restore stop could not be verified'
          )
        }
        console.warn('[pty] closed scoped terminal remains unverified', error)
      })
    } catch {
      /* The owning remote host retains its existing retirement path. */
    }
  }
  retire(oldLayout?.root ?? null)
}
