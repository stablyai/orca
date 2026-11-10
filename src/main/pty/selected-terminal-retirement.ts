import type { IPtyProvider, PtySpawnResult } from '../providers/pty-provider-contract'

import {
  locateLegacyTerminalRestore,
  type LegacyTerminalRestoreAttempt
} from './legacy-terminal-restore-ownership'
import type { LegacyTerminalIdentityClaims } from '../persistence/loading-store/legacy-terminal-identity-claims'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'

type SelectedTerminal = {
  attempt?: LegacyTerminalRestoreAttempt
  authority: LegacyTerminalIdentityClaims
  workspace: string
  paneKey: string
  provider: IPtyProvider
  result: Pick<PtySpawnResult, 'id' | 'incarnationId'>
}
const pending = new WeakMap<PtySpawnResult, SelectedTerminal>()
const selected = new Map<string, SelectedTerminal>()

export function stageSelectedTerminal(result: PtySpawnResult, owner: SelectedTerminal): void {
  pending.set(result, owner)
}
export function publishSelectedTerminal(result: PtySpawnResult): void {
  const owner = pending.get(result)
  if (owner && result.incarnationId) {
    selected.set(result.id, owner)
  }
  pending.delete(result)
}

export function forgetSelectedTerminal(id: string): void {
  selected.delete(id)
}

export function selectedTerminalForPane(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  paneKey: string,
  id: string,
  incarnationId: string | undefined
): SelectedTerminal | undefined {
  const owner = selected.get(id)
  return owner?.authority === authority &&
    owner.workspace === workspace &&
    (owner.attempt?.tabId && owner.attempt.leafId
      ? makePaneKey(owner.attempt.tabId, owner.attempt.leafId)
      : owner.paneKey) === paneKey &&
    owner.result.incarnationId === incarnationId
    ? owner
    : undefined
}

export function transferSelectedTerminal(
  authority: LegacyTerminalIdentityClaims,
  workspace: string,
  source: string,
  destination: string,
  id: string,
  incarnationId: string | undefined
): () => void {
  const owner = selectedTerminalForPane(authority, workspace, source, id, incarnationId)
  if (!owner) {
    return () => {}
  }
  const attempt = owner.attempt
  const tabId = attempt?.tabId
  const leafId = attempt?.leafId
  const prior = owner.paneKey
  owner.paneKey = destination
  const [nextTab, nextLeaf] = destination.split(':')
  if (attempt) {
    locateLegacyTerminalRestore(authority, attempt, nextTab, nextLeaf)
  }
  const revision = attempt?.revision
  return () => {
    if (owner.paneKey !== destination || (attempt && attempt.revision !== revision)) {
      return
    }
    owner.paneKey = prior
    if (attempt && !attempt.closed) {
      if (tabId && leafId) {
        locateLegacyTerminalRestore(authority, attempt, tabId, leafId)
      }
    }
  }
}
