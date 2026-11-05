import { OrcaRuntimeWithFocusTerminal } from '../terminal/focus/focus-terminal'
import { EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS } from '../orca-runtime-core'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import type {
  RuntimeTerminalClose,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import { errorMessage } from '../../../shared/error-message'

/** How an explicit close's stop of its addressed PTY ended. */
export type ExplicitCloseStop = { stopped: boolean }

export type ExplicitCloseScope = { worktreeId: string; tabId: string; leafId?: string }

export type ExplicitCloseTarget = { ptyId: string; isCurrent: () => boolean }

export const NO_STOP: ExplicitCloseStop = { stopped: false }

export abstract class OrcaRuntimeWithExplicitCloseTabPtyStops extends OrcaRuntimeWithFocusTerminal {
  protected captureExplicitCloseTargets(
    ptyIds: readonly string[],
    scope: ExplicitCloseScope
  ): ExplicitCloseTarget[] {
    const ids = new Set(ptyIds)
    const records = [...ids].map((ptyId) => ({ ptyId, record: this.ptysById.get(ptyId) }))
    const workspaces = new Set(records.flatMap(({ record }) => (record ? [record.worktreeId] : [])))
    // Call-local: one pass per current workspace publication, shared by every sequential stop.
    const publications = new Map<
      string,
      { snapshot: RuntimeMobileSessionTabsSnapshot; owners: Map<string, Set<string>> }
    >()
    const ownersOf = (worktreeId: string): Map<string, Set<string>> => {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!snapshot) {
        publications.delete(worktreeId)
        return new Map()
      }
      const prior = publications.get(worktreeId)
      if (prior?.snapshot === snapshot) {
        return prior.owners
      }
      const owners = new Map<string, Set<string>>()
      for (const row of snapshot.tabs) {
        if (row.type !== 'terminal') {
          continue
        }
        for (const id of new Set([row.ptyId, row.parentLayout?.ptyIdsByLeafId?.[row.leafId]])) {
          if (!id || !ids.has(id)) {
            continue
          }
          const panes = owners.get(id) ?? new Set<string>()
          panes.add(`${worktreeId}\0${row.parentTabId}\0${row.leafId}`)
          owners.set(id, panes)
        }
      }
      publications.set(worktreeId, { snapshot, owners })
      return owners
    }
    // Dormant SSH identities have no runtime record; their published workspace remains the owner.
    if (records.some(({ ptyId, record }) => !record && parseAppSshPtyId(ptyId))) {
      for (const workspace of this.mobileSessionTabsByWorktree.keys()) {
        if (ownersOf(workspace).size) {
          workspaces.add(workspace)
        }
      }
    }
    return records.map(({ ptyId, record }) => {
      const incarnationId = record?.incarnationId
      const providerIsCurrent =
        this.ptyController?.captureStopExpectation?.(ptyId, incarnationId ?? undefined) ??
        (() => true)
      const worktreeId = record?.worktreeId
      const pane = this.paneOfPty(record)
      const inside = (workspace: string, tabId: string, leafId: string): boolean =>
        workspace === scope.worktreeId &&
        tabId === scope.tabId &&
        (scope.leafId === undefined || leafId === scope.leafId)
      const ownsOnlyClosingScope = (capturedOwner = false): boolean => {
        let hasCurrentOwner = false
        for (const leaf of this.getLeavesForPty(ptyId)) {
          if (!inside(leaf.worktreeId, leaf.tabId, leaf.leafId)) {
            return false
          }
          hasCurrentOwner = true
        }
        const currentWorkspaces = record ? workspaces : this.mobileSessionTabsByWorktree.keys()
        for (const workspace of currentWorkspaces) {
          for (const owner of ownersOf(workspace).get(ptyId) ?? []) {
            const [ownerWorkspace, tabId, leafId] = owner.split('\0')
            if (!inside(ownerWorkspace, tabId, leafId)) {
              return false
            }
            hasCurrentOwner = true
          }
        }
        if (hasCurrentOwner || capturedOwner) {
          return true
        }
        const currentPane = this.paneOfPty(this.ptysById.get(ptyId))
        const parsed = parsePaneKey(currentPane.paneKey ?? '')
        return (
          (currentPane.tabId === null || currentPane.tabId === scope.tabId) &&
          (!parsed || inside(worktreeId ?? scope.worktreeId, parsed.tabId, parsed.leafId))
        )
      }
      // Losing a closing binding is expected; an outside owner never grants stop authority.
      const ownedAtCapture = ownsOnlyClosingScope()
      return {
        ptyId,
        isCurrent: () => {
          const current = this.ptysById.get(ptyId)
          if (
            !providerIsCurrent() ||
            current !== record ||
            (!record && !parseAppSshPtyId(ptyId)) ||
            current?.incarnationId !== incarnationId ||
            current?.worktreeId !== worktreeId
          ) {
            return false
          }
          const now = this.paneOfPty(current)
          if (
            (now.tabId !== null && now.tabId !== pane.tabId) ||
            (now.paneKey !== null && now.paneKey !== pane.paneKey)
          ) {
            return false
          }
          return ownedAtCapture && ownsOnlyClosingScope(true)
        }
      }
    })
  }

  protected describeTerminalClose(
    handle: string,
    tabId: string,
    ptyId: string | null,
    stop: ExplicitCloseStop
  ): RuntimeTerminalClose {
    const close: RuntimeTerminalClose = { handle, tabId, ptyKilled: stop.stopped }
    if (stop.stopped || !ptyId) {
      return close
    }
    const verdict = this.getPtyLivenessVerdict(ptyId)
    if (verdict?.status === 'unverifiable') {
      return { ...close, ptyStopVerdict: 'unverifiable', ptyStopReason: verdict.reason }
    }
    if (verdict?.status === 'live') {
      return { ...close, ptyStopVerdict: 'live' }
    }
    return close
  }

  protected async stopExplicitlyClosedTabPtys(
    targets: readonly ExplicitCloseTarget[],
    addressedPtyId: string
  ): Promise<ExplicitCloseStop> {
    let addressedPtyStop = NO_STOP
    const deadlineMs = Date.now() + EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS
    for (const { ptyId, isCurrent } of targets) {
      if (!isCurrent()) {
        continue
      }
      this.markPtyStopRequested(ptyId)
      const expectedIncarnationId = this.ptysById.get(ptyId)?.incarnationId ?? undefined
      let stopped = false
      if (this.ptyController?.stopAndWait) {
        try {
          stopped = await this.ptyController.stopAndWait(ptyId, {
            deadlineMs,
            isCurrent
          })
        } catch (error) {
          if (isCurrent()) {
            this.markPtyLivenessUnverifiable(ptyId, errorMessage(error))
          }
        }
        if (!isCurrent()) {
          continue
        }
        // Preserve an observed exit when a broader inventory check could not finish.
        if (
          !stopped &&
          expectedIncarnationId &&
          this.ptysById.get(ptyId)?.incarnationId === expectedIncarnationId &&
          this.getPtyLivenessVerdict(ptyId)?.status === 'exited'
        ) {
          stopped = true
        }
        if (!stopped) {
          const verdict = this.getPtyLivenessVerdict(ptyId)
          const providerAlreadyRetiredPty =
            verdict?.status === 'unverifiable' &&
            verdict.reason === SSH_PROVIDER_UNREGISTERED_REASON
          if (!providerAlreadyRetiredPty) {
            this.ptyController.kill(ptyId, { isCurrent })
            if (!verdict || verdict.status === 'live') {
              this.markPtyLivenessUnverifiable(
                ptyId,
                'a follow-up stop was issued but its outcome could not be verified'
              )
            }
          }
        }
      } else {
        stopped = this.ptyController?.kill(ptyId, { isCurrent }) ?? false
      }
      if (ptyId === addressedPtyId) {
        addressedPtyStop = { stopped }
      }
    }
    return addressedPtyStop
  }
}
