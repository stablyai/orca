import {
  acquireProspectivePtySpawn,
  bindProspectivePtySpawn,
  carryProspectivePtySpawn,
  type ProspectivePtySpawn
} from '../../../pty/prospective-pty-spawn'
import type { Store } from '../../../persistence/loading-store/store'
import type { AdoptStablePaneArgs, PtySpawnIpcArgs } from '../ipc/spawn-types'
import type { PtySpawnOptions } from '../../../providers/pty-provider-contract'
import { peekDaemonHistoryRoot } from '../../../daemon/launch/daemon-launch-paths'
import { legacyPanePtySessionId } from '../../../daemon/sessions/pty-session-id'
import {
  hasCommittedTerminalHistoryIdentity,
  installTerminalHistoryIdentity
} from '../../../daemon/history/storage/terminal-history-identity-install'
import { makePaneKey, parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { terminalTreeHasLeaf } from '../../../../shared/workspace-layout/terminal-tab-close'
import type { PtySpawnOperationState } from '../spawn-operation-state'
import type { PaneSpawnOperation } from './pane-spawn-operation'
import type { LegacyTerminalRestoreAttempt } from '../../../pty/legacy-terminal-restore-ownership'
import { getProvider } from '../provider/registry'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

const selectedIdentity = Symbol('selectedLegacyTerminalIdentity')
type Selection = { id: string; attempt: LegacyTerminalRestoreAttempt }
export type LegacyIdentityCarrier = Pick<PtySpawnOptions, 'cols' | 'rows'> & {
  [selectedIdentity]?: Selection
}

export function carrySelectedLegacyIdentity(
  source: LegacyIdentityCarrier,
  target: LegacyIdentityCarrier
): void {
  carryProspectivePtySpawn(source, target)
  const selection = source[selectedIdentity]
  if (selection) {
    Object.assign(target, { [selectedIdentity]: selection })
  }
}

export function assertSelectedLegacyIdentityOpen(options: LegacyIdentityCarrier): void {
  const selection = options[selectedIdentity]
  if (selection?.attempt.closed) {
    throw new Error('terminal_pane_owner_changed')
  }
}

export function selectedLegacyIdentity(
  options: LegacyIdentityCarrier | undefined
): Selection | undefined {
  return options?.[selectedIdentity]
}

export function legacyPaneRestoreAttempt(
  options: (LegacyIdentityCarrier & { paneSpawnOperation?: PaneSpawnOperation }) | undefined
): LegacyTerminalRestoreAttempt | undefined {
  return (
    selectedLegacyIdentity(options)?.attempt ?? options?.paneSpawnOperation?.legacyRestore?.attempt
  )
}

export function applyLegacyPaneAcquisition(
  operation: PaneSpawnOperation,
  target: LegacyIdentityCarrier & {
    sessionId?: string
    tabId?: string
    leafId?: string
    signal?: AbortSignal
  }
): boolean {
  const context = operation.legacyRestore
  if (!context) {
    return false
  }
  if (context.attempt.closed) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (context.attempt.tabId && context.attempt.leafId) {
    Object.assign(target, { tabId: context.attempt.tabId, leafId: context.attempt.leafId })
  }
  const carrier = context.carrier
  const selection = selectedLegacyIdentity(carrier)
  if (!carrier || !selection) {
    return false
  }
  const changed = target.sessionId !== selection.id || selectedLegacyIdentity(target) !== selection
  carrySelectedLegacyIdentity(carrier, target)
  target.sessionId = selection.id
  target.signal = target.signal
    ? AbortSignal.any([target.signal, context.attempt.close.signal])
    : context.attempt.close.signal
  return changed
}

export function rebaseLegacyPtyRequest(ctx: PtySpawnOperationState): void {
  const args = ctx.args
  if (
    !args.worktreeId ||
    !args.tabId ||
    !args.leafId ||
    args.connectionId ||
    !/^\d+$/.test(args.sessionId ?? '')
  ) {
    return
  }
  const saved = ctx.deps.store?.getWorkspaceSession?.()
  const current = saved?.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
  if (current === legacyPanePtySessionId(args.worktreeId, args.leafId, args.sessionId!)) {
    args.sessionId = current
  }
}

export function legacyPaneIdentitySelection(
  ctx: {
    deps: { store?: Store }
    args: Pick<
      AdoptStablePaneArgs,
      'cols' | 'rows' | 'cwd' | 'signal' | 'connectionId' | 'worktreeId'
    > &
      Partial<Pick<AdoptStablePaneArgs, 'tabId' | 'leafId'>> &
      Partial<Pick<PtySpawnIpcArgs, 'sessionId'>> & {
        isNewSession?: boolean
        attachOnlyView?: unknown
      }
    cwd?: string
  },
  paneKey: string,
  attempt: LegacyTerminalRestoreAttempt | undefined
) {
  const { store } = ctx.deps
  const args = ctx.args
  const pane = parsePaneKey(paneKey)
  const workspace = args.worktreeId
  if (
    !attempt ||
    !store ||
    !pane ||
    !workspace ||
    args.connectionId ||
    args.isNewSession ||
    args.attachOnlyView
  ) {
    return null
  }
  const session = store.getWorkspaceSession()
  const row = session.tabsByWorktree?.[workspace]?.find((row) => row.id === pane.tabId)
  const layout = session.terminalLayoutsByTabId?.[pane.tabId]
  const bound = layout?.ptyIdsByLeafId?.[pane.leafId]
  const originalId =
    bound ??
    (layout?.root?.type === 'leaf' && layout.root.leafId === pane.leafId ? row?.ptyId : undefined)
  if (
    (!row || !terminalTreeHasLeaf(layout?.root, pane.leafId)) &&
    /^\d+$/.test(args.sessionId ?? '')
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (!row || !originalId || !/^\d+$/.test(originalId)) {
    return null
  }
  const root = peekDaemonHistoryRoot()
  if (!root) {
    return null
  }
  const canonicalId = legacyPanePtySessionId(workspace, pane.leafId, originalId)
  const revision = store.legacyTerminalIdentityAuthority.revision
  const incarnation = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  attempt.originalId = originalId
  attempt.originalIncarnation = incarnation
  const location = () => ({ tabId: attempt.tabId!, leafId: attempt.leafId! })
  const currentPaneKey = () => makePaneKey(attempt.tabId!, attempt.leafId!)
  const follow = (target: { tabId?: string; leafId?: string }) => Object.assign(target, location())
  const current = (): boolean => {
    if (attempt.closed || args.signal?.aborted) {
      return false
    }
    const now = store.getWorkspaceSession()
    return (
      now.tabsByWorktree?.[workspace]?.some((row) => row.id === attempt.tabId) === true &&
      now.terminalLayoutsByTabId?.[attempt.tabId!]?.ptyIdsByLeafId?.[attempt.leafId!] ===
        originalId &&
      now.terminalPtyIncarnationsByPaneKey?.[currentPaneKey()] === incarnation
    )
  }
  let committed: boolean | undefined
  const hasCanonical = (refresh = false): boolean => {
    if (refresh || committed === undefined) {
      committed = hasCommittedTerminalHistoryIdentity(root.path, canonicalId)
    }
    return committed
  }
  let prospective: ProspectivePtySpawn | null = null
  const provider = getProvider(LOCAL_EXECUTION_HOST_ID)
  const admitTarget = async () =>
    (prospective ??= await acquireProspectivePtySpawn(provider, {
      sessionId: canonicalId,
      worktreeId: workspace,
      cwd: ctx.cwd ?? args.cwd,
      cols: args.cols,
      rows: args.rows
    }))
  return {
    release: () => prospective?.release(),
    follow,
    originalId,
    canonicalSelected: () =>
      root.matchesProfile(store.legacyTerminalIdentityAuthority.canonicalProfile) && hasCanonical(),
    prepareOwner: async () => {
      await Promise.all([
        root.profileReady(),
        store.legacyTerminalIdentityAuthority.canonicalProfileReady
      ])
      if (!root.matchesProfile(store.legacyTerminalIdentityAuthority.canonicalProfile)) {
        return
      }
      if (attempt.closed) {
        throw new Error('terminal_pane_owner_changed')
      }
      if (
        !store.legacyTerminalIdentityAuthority.unique(workspace, currentPaneKey(), originalId) &&
        !hasCanonical()
      ) {
        return
      }
      if (!hasCanonical() && !(await admitTarget())) {
        return
      }
      if (
        !(await store.prepareLegacyTerminalIdentity(() => ({
          worktreeId: workspace,
          ...location(),
          ptyId: originalId,
          incarnationId: incarnation
        })))
      ) {
        if (!current()) {
          throw new Error('terminal_pane_owner_changed')
        }
      }
    },
    select: async (
      operation: PaneSpawnOperation,
      target: LegacyIdentityCarrier & { sessionId?: string }
    ) => {
      if (!root.matchesProfile(store.legacyTerminalIdentityAuthority.canonicalProfile)) {
        return
      }
      if (!current()) {
        throw new Error('terminal_pane_owner_changed')
      }
      follow(args)
      const locationRevision = attempt.revision
      let selected = hasCanonical(true)
      if (
        !selected &&
        (prospective ?? (await admitTarget())) !== null &&
        store.legacyTerminalIdentityAuthority.unique(workspace, currentPaneKey(), originalId)
      ) {
        selected =
          (await installTerminalHistoryIdentity(
            root,
            originalId,
            canonicalId,
            { cwd: ctx.cwd ?? args.cwd ?? '', cols: args.cols, rows: args.rows },
            () =>
              current() &&
              revision === store.legacyTerminalIdentityAuthority.revision &&
              attempt.revision === locationRevision &&
              prospective?.currentSync() === true &&
              store.legacyTerminalIdentityAuthority.unique(workspace, currentPaneKey(), originalId),
            args.signal
          )) === 'canonical'
      }
      if (attempt.closed) {
        throw new Error('terminal_pane_owner_changed')
      }
      follow(args)
      if (!selected) {
        return
      }
      // Metadata owns retry identity even if dispatch/binding fails or a window still sends N.
      attempt.selectedId = canonicalId
      operation.mustExist = true
      operation.absentOwner ??= {
        ptyId: originalId,
        incarnationIds: incarnation ? [incarnation] : []
      }
      prospective ??= await admitTarget()
      if (!prospective || !(await prospective.current())) {
        throw new Error('Terminal spawn target changed')
      }
      bindProspectivePtySpawn(target, provider, prospective)
      const selection = { id: canonicalId, attempt }
      target.sessionId = canonicalId
      Object.assign(target, { [selectedIdentity]: selection })
    }
  }
}
