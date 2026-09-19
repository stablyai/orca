import { readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  pruneLocalTerminalScrollbackBuffers,
  type RepoConnection
} from '../../../shared/workspace-session-terminal-buffers'
import {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  type PtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-journal-contract'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS } from '../../../shared/pty-ownership-transfer-destination-adapter'
import { publicationReceiptMatchesPtyOwnershipTransfer } from '../../../shared/pty-ownership-transfer-receipt-validation'
import type { PtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { samePtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  parsePtyOwnershipTransferDestinationFile,
  readPtyOwnershipTransferDestinationFile
} from '../pty-ownership-transfer/pty-ownership-transfer-destination-file'
import { ptyOwnershipTransferDestinationDirectory } from '../pty-ownership-transfer/pty-ownership-transfer-destination-file-store-contract'
import {
  ownershipTransferSurfaceSnapshotRef,
  ownershipTransferSurfaceModelSnapshotRef
} from '../pty-ownership-transfer/pty-ownership-transfer-snapshot-reference'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

type PublicationEvidence = {
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
}
type HistoryOwner = {
  binding: PtyOwnershipTransferSurfaceBinding
  incarnationId: string
  refs: ReadonlySet<string>
}

/** Load once per Store; publication updates the index without rescanning output journals. */
export class PtyOwnershipTransferSnapshotHistory {
  private loaded = false
  private unverifiable = false
  private readonly owners = new Map<string, HistoryOwner>()

  constructor(private readonly profileDirectory: string) {}

  recordPublication(evidence: PublicationEvidence): void {
    this.load()
    if (
      !publicationReceiptMatchesPtyOwnershipTransfer(
        evidence.publicationReceipt,
        evidence.identity,
        evidence.publicationReceipt.commitReceipt
      ) ||
      !samePtyOwnershipTransferSurfaceBinding(
        evidence.publicationReceipt.surfaceBinding,
        evidence.surfaceBinding
      )
    ) {
      throw new Error('pty_ownership_transfer_history_evidence_invalid')
    }
    const owner: HistoryOwner = {
      binding: structuredClone(evidence.surfaceBinding),
      incarnationId: evidence.identity.incarnationId,
      refs: new Set([
        ownershipTransferSurfaceSnapshotRef(evidence),
        ownershipTransferSurfaceModelSnapshotRef(evidence)
      ])
    }
    const existing = this.owners.get(evidence.identity.bridgeId)
    if (
      existing &&
      (!samePtyOwnershipTransferSurfaceBinding(existing.binding, owner.binding) ||
        existing.incarnationId !== owner.incarnationId ||
        [...existing.refs].some((ref) => !owner.refs.has(ref)))
    ) {
      throw new Error('pty_ownership_transfer_history_evidence_conflict')
    }
    this.owners.set(evidence.identity.bridgeId, owner)
  }

  prune(
    session: WorkspaceSessionState,
    repos: readonly RepoConnection[],
    prior?: WorkspaceSessionState,
    hostId = 'local'
  ): WorkspaceSessionState {
    this.load()
    const pruned = pruneLocalTerminalScrollbackBuffers(session, repos)
    let layouts: WorkspaceSessionState['terminalLayoutsByTabId'] | undefined
    for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId)) {
      const previous = prior?.terminalLayoutsByTabId[tabId]
      const leaves = collectLayoutLeafIdsInOrder(layout.root)
      const candidates = new Set([
        ...Object.keys(layout.scrollbackRefsByLeafId ?? {}),
        ...Object.keys(previous?.scrollbackRefsByLeafId ?? {})
      ])
      for (const leafId of candidates) {
        if (
          leaves.filter((id) => id === leafId).length !== 1 ||
          session.terminalSurfaceTombstonesByPaneKey?.[`${tabId}:${leafId}`] ||
          session.closedTerminalTabTombstonesByTabId?.[tabId]
        ) {
          continue
        }
        const refs = [
          prior && sameSurface(session, prior, tabId, leafId)
            ? previous?.scrollbackRefsByLeafId?.[leafId]
            : undefined,
          layout.scrollbackRefsByLeafId?.[leafId]
        ]
        const ownsRef = (ref: string): boolean =>
          [...this.owners.values()].some(
            (entry) =>
              entry.binding.executionHostId === hostId &&
              entry.binding.tabId === tabId &&
              entry.binding.leafId === leafId &&
              entry.refs.has(ref) &&
              matchesOwner(session, entry)
          )
        const ref = refs.find((ref) => ref !== undefined && (this.unverifiable || ownsRef(ref)))
        const current = layouts?.[tabId] ?? pruned.terminalLayoutsByTabId[tabId]
        const removeInline =
          ref !== undefined && ownsRef(ref) && Object.hasOwn(current.buffersByLeafId ?? {}, leafId)
        if (
          ref === undefined ||
          (current.scrollbackRefsByLeafId?.[leafId] === ref && !removeInline)
        ) {
          continue
        }
        layouts ??= { ...pruned.terminalLayoutsByTabId }
        const { buffersByLeafId, ...withoutBuffers } = current
        const buffers = removeInline
          ? Object.fromEntries(
              Object.entries(buffersByLeafId ?? {}).filter(([id]) => id !== leafId)
            )
          : buffersByLeafId
        layouts[tabId] = {
          ...withoutBuffers,
          ...(buffers && Object.keys(buffers).length ? { buffersByLeafId: buffers } : {}),
          scrollbackRefsByLeafId: { ...current.scrollbackRefsByLeafId, [leafId]: ref }
        }
      }
    }
    return layouts ? { ...pruned, terminalLayoutsByTabId: layouts } : pruned
  }

  private load(): void {
    if (this.loaded) {
      return
    }
    this.loaded = true
    const directory = ptyOwnershipTransferDestinationDirectory(this.profileDirectory)
    let files: string[]
    try {
      files = readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    } catch (error) {
      this.unverifiable = !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
      return
    }
    try {
      if (files.length > MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
        throw new Error('history journal capacity exceeded')
      }
      for (const file of files) {
        const record = parsePtyOwnershipTransferDestinationFile(
          readPtyOwnershipTransferDestinationFile(join(directory, file)),
          PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
        )
        if (`${createHash('sha256').update(record.journal.bridgeId).digest('hex')}.json` !== file) {
          throw new Error('history journal filename mismatch')
        }
        if (
          record.journal.phase !== 'aborted' &&
          record.surfaceBinding &&
          record.publicationIntent
        ) {
          this.recordPublication({
            identity: record.journal,
            surfaceBinding: record.surfaceBinding,
            publicationReceipt: record.publicationIntent
          })
        }
      }
    } catch {
      // Unreadable ownership evidence must not license deleting history references.
      this.unverifiable = true
    }
  }
}

function matchesOwner(session: WorkspaceSessionState, owner: HistoryOwner): boolean {
  const binding = owner.binding
  const scope = parseWorkspaceKey(binding.workspaceKey)
  if (!scope) {
    return false
  }
  const ownerKey = scope.type === 'folder' ? `folder:${scope.folderWorkspaceId}` : scope.worktreeId
  const tabs = Object.entries(session.tabsByWorktree).flatMap(([key, tabs]) =>
    tabs.filter((tab) => tab.id === binding.tabId).map((tab) => ({ key, tab }))
  )
  const layout = session.terminalLayoutsByTabId[binding.tabId]
  return (
    tabs.length === 1 &&
    tabs[0].key === ownerKey &&
    tabs[0].tab.worktreeId === ownerKey &&
    layout?.ptyIdsByLeafId?.[binding.leafId] === binding.ptyId &&
    collectLayoutLeafIdsInOrder(layout?.root).filter((id) => id === binding.leafId).length === 1 &&
    session.terminalPtyIncarnationsByPaneKey?.[`${binding.tabId}:${binding.leafId}`] ===
      owner.incarnationId &&
    !session.terminalSurfaceTombstonesByPaneKey?.[`${binding.tabId}:${binding.leafId}`] &&
    !session.closedTerminalTabTombstonesByTabId?.[binding.tabId]
  )
}

function sameSurface(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  tabId: string,
  leafId: string
): boolean {
  const pane = `${tabId}:${leafId}`
  const owner = (session: WorkspaceSessionState) =>
    Object.entries(session.tabsByWorktree)
      .filter(([, tabs]) => tabs.some((tab) => tab.id === tabId))
      .map(([key]) => key)
  return (
    JSON.stringify(owner(next)) === JSON.stringify(owner(prior)) &&
    next.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] ===
      prior.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId] &&
    next.terminalPtyIncarnationsByPaneKey?.[pane] ===
      prior.terminalPtyIncarnationsByPaneKey?.[pane] &&
    !next.terminalSurfaceTombstonesByPaneKey?.[pane] &&
    !next.closedTerminalTabTombstonesByTabId?.[tabId]
  )
}
