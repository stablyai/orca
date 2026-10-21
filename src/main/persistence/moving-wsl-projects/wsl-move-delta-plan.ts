/**
 * What a move into a distro's host takes (mover design, sections 4.3 and 5): the first move takes
 * the selected projects; every later one is a delta move, a new journal record chained by
 * `supersedesMigrationId`, that takes only projects no earlier move of the distro took. One move
 * per distro is in flight at a time.
 *
 * A project an earlier move took and an older build has since changed is listed, not taken: the
 * host already holds it under the same ids and refuses a second copy, so the change stays in the
 * retained row (as SSH's delta does; see `planOrcadDeltaMove`). The same goes for a project the
 * host still holds after its move was dropped from the journal.
 */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { isOrcadMigrationLocalWslSource } from '../../../shared/orcad-migration/orcad-migration-source-kind'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import {
  WSL_MOVE_CUTOVER_PHASES,
  WSL_MOVE_CUTOVER_VERSION,
  isWslMoveCutoverFinished,
  wslMoveJournalKey,
  type WslMoveCutover
} from '../../../shared/wsl-move/wsl-move-cutover'
import {
  listWslMoveCutoverChain,
  scanWslMoveCutovers,
  writeWslMoveCutover
} from './wsl-move-cutover-journal'
import {
  wslMoveLocalRowIdentity,
  wslMoveRowKey,
  wslMoveScopeRefs,
  wslMoveTakenRowIdentity,
  type WslMoveRowRef
} from './wsl-move-retained-source'
import { collectWslMoveScope, type WslMoveScope } from './wsl-move-scope'
import { isLocalWslMoveRow } from './wsl-move-scope-guard'

type WslMovePlanState = {
  repos: readonly Repo[]
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
}

/** What the destination host holds now, read before planning: the journal alone can't say. */
export type WslMoveHostHolding = {
  repoIds: readonly string[]
  folderWorkspaceIds: readonly string[]
  /** The highest source generation it has received for this distro; 0 for none. */
  highestGeneration: number
}

export type WslMovePlanRefusal =
  /** Another move of this distro has not finished; it resumes or resets first. */
  | 'wsl_move_already_in_flight'
  /** Every selected project is already on the host, unchanged or not. */
  | 'wsl_move_nothing_new'

export type WslMovePlan = {
  distro: string
  journalKey: string
  /** The finished move this one extends; absent for the distro's first move. */
  supersedesMigrationId?: string
  /** A delta goes to the host the chain already uses. */
  destinationEnvironmentId?: string
  generation: number
  repoIds: string[]
  folderWorkspaceIds: string[]
  /** Taken earlier, then changed by an older build: listed for the user, not moved again. */
  changed: WslMoveRowRef[]
  /** Taken earlier, and no longer in this profile; the host keeps its copy. */
  removed: WslMoveRowRef[]
  /** On the host with no move to show for it, e.g. after "Use on this computer again". */
  heldByHost: WslMoveRowRef[]
  refused: WslMoveScope['refused']
}

export type WslMovePlanResult =
  | { outcome: 'ready'; plan: WslMovePlan }
  | { outcome: 'refused'; code: WslMovePlanRefusal }

const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')

const refsOf = (scope: {
  repoIds: readonly string[]
  folderWorkspaceIds: readonly string[]
}): WslMoveRowRef[] => [
  ...scope.repoIds.map((id) => ({ kind: 'repo' as const, id })),
  ...scope.folderWorkspaceIds.map((id) => ({ kind: 'folder' as const, id }))
]

/** Throws only when the journal cannot be read. */
export function planWslMove(
  userDataPath: string,
  state: WslMovePlanState,
  distro: string,
  host: WslMoveHostHolding,
  /** The projects the user ticked; absent means the whole distro. */
  selection?: { repoIds: readonly string[]; folderWorkspaceIds: readonly string[] }
): WslMovePlanResult {
  const journalKey = wslMoveJournalKey(distro)
  const chain = listWslMoveCutoverChain(userDataPath, journalKey)
  const head = chain.at(-1)
  if (head && !isWslMoveCutoverFinished(head)) {
    return { outcome: 'refused', code: 'wsl_move_already_in_flight' }
  }
  // Newest move per row: what the host holds for it now.
  const taken = new Map<string, { ref: WslMoveRowRef; owner: Readonly<WslMoveCutover> }>()
  for (const cutover of chain) {
    for (const ref of wslMoveScopeRefs(cutover)) {
      taken.set(wslMoveRowKey(ref), { ref, owner: cutover })
    }
  }
  // Another distro's host owns these, even if an older build has since pointed them here.
  const ownedElsewhere = new Set(
    scanWslMoveCutovers(userDataPath)
      .filter(
        (cutover) =>
          cutover.journalKey !== journalKey &&
          WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM
      )
      .flatMap((cutover) => wslMoveScopeRefs(cutover).map(wslMoveRowKey))
  )
  const held = new Set(refsOf(host).map(wslMoveRowKey))
  const scope = collectWslMoveScope(state, distro)
  const selected = (ref: WslMoveRowRef): boolean =>
    !selection ||
    (ref.kind === 'repo' ? selection.repoIds : selection.folderWorkspaceIds).includes(ref.id)
  // Local rows only: the host's own row carries the same id.
  const rows = new Map<string, Repo | FolderWorkspace>()
  for (const repo of state.repos) {
    if (isLocalWslMoveRow(repo)) {
      rows.set(wslMoveRowKey({ kind: 'repo', id: repo.id }), repo)
    }
  }
  for (const folder of state.folderWorkspaces) {
    if (isLocalWslMoveRow(folder)) {
      rows.set(wslMoveRowKey({ kind: 'folder', id: folder.id }), folder)
    }
  }
  const candidates = refsOf(scope)
  const inScope = new Set(candidates.map(wslMoveRowKey))
  const fresh: WslMoveRowRef[] = []
  const changed: WslMoveRowRef[] = []
  const heldByHost: WslMoveRowRef[] = []
  for (const ref of candidates) {
    const key = wslMoveRowKey(ref)
    if (taken.has(key)) {
      continue
    }
    if (ownedElsewhere.has(key)) {
      changed.push(ref)
    } else if (held.has(key)) {
      heldByHost.push(ref)
    } else if (selected(ref)) {
      fresh.push(ref)
    }
  }
  const removed: WslMoveRowRef[] = []
  for (const [key, { ref, owner }] of taken) {
    const row = rows.get(key)
    if (!row) {
      removed.push(ref)
    } else if (
      // Out of scope now (a path left the distro), or another identity.
      !inScope.has(key) ||
      wslMoveTakenRowIdentity(owner, ref) !== wslMoveLocalRowIdentity(row, distro)
    ) {
      changed.push(ref)
    }
  }
  if (fresh.length === 0) {
    return { outcome: 'refused', code: 'wsl_move_nothing_new' }
  }
  return {
    outcome: 'ready',
    plan: {
      distro,
      journalKey,
      ...(head
        ? {
            supersedesMigrationId: head.migrationId,
            destinationEnvironmentId: head.destinationEnvironmentId
          }
        : {}),
      // Strictly increasing even past a dropped move, whose generation only the host remembers.
      generation: Math.max(head?.manifest.source.generation ?? 0, host.highestGeneration) + 1,
      repoIds: fresh.filter((ref) => ref.kind === 'repo').map((ref) => ref.id),
      folderWorkspaceIds: fresh.filter((ref) => ref.kind === 'folder').map((ref) => ref.id),
      changed,
      removed,
      heldByHost,
      refused: scope.refused
    }
  }
}

// Duplicates fail: a doubled id could hide a row the manifest carries but the journal never fences.
const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  left.length === right.length &&
  new Set([...left, ...right]).size === left.length

/**
 * Journals a planned move at `prepared`. The manifest must be exactly the plan's scope, and the
 * journal refuses it if another move of the distro journaled or finished since the plan was made.
 */
export function journalWslMove(args: {
  userDataPath: string
  plan: WslMovePlan
  manifest: OrcadMigrationManifest
  destinationName: string
  now?: () => Date
}): WslMoveCutover {
  const { plan, manifest } = args
  const { source, destinationEnvironmentId } = manifest
  if (
    !destinationEnvironmentId ||
    !isOrcadMigrationLocalWslSource(source) ||
    wslMoveJournalKey(source.distro) !== plan.journalKey ||
    source.generation !== plan.generation ||
    !sameIds(source.scopeRepoIds, plan.repoIds) ||
    !sameIds(source.scopeFolderWorkspaceIds, plan.folderWorkspaceIds) ||
    (plan.destinationEnvironmentId !== undefined &&
      destinationEnvironmentId !== plan.destinationEnvironmentId)
  ) {
    throw new Error('wsl_move_manifest_not_planned')
  }
  const timestamp = (args.now ?? (() => new Date()))().toISOString()
  const cutover: WslMoveCutover = {
    version: WSL_MOVE_CUTOVER_VERSION,
    migrationId: manifest.migrationId,
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    destinationEnvironmentId,
    destinationName: args.destinationName,
    journalKey: plan.journalKey,
    manifestSha256: manifest.manifestSha256,
    provenExitedSessionIds: [],
    rewrittenStores: [],
    ...(plan.supersedesMigrationId ? { supersedesMigrationId: plan.supersedesMigrationId } : {}),
    manifest: { ...manifest, source }
  }
  // The journal re-checks under its own read: one in-flight move, extending the current head.
  writeWslMoveCutover(args.userDataPath, cutover)
  return cutover
}
