import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import type { PreparedPtyObservationAdmission } from '../../../runtime/runtime-pty-observation-capsule'

/** The pane whose durable binding this commit is about to overwrite. */
export type SpawnObservationSurface = { worktreeId: string; tabId: string; leafId: string }

type SpawnObservationAdmissionState = {
  deps: {
    runtime?: {
      preparePtyObservationAdmission?: (
        token: string | null,
        ptyId: string,
        incarnationId?: string,
        surface?: SpawnObservationSurface
      ) => PreparedPtyObservationAdmission | null
    } | null
  }
  args: { worktreeId?: string; tabId?: unknown }
  metadataLeafId: string | null
  hostSessionBinding?: { worktreeId: string; tabId: string; leafId: string } | null
  stablePaneOwner?: { tabId: string; leafId: string } | null
  observationAdmissionToken: string | null
  result: {
    id: string
    incarnationId?: string
    agentSessionEnsure?: {
      owner: { surface: { worktreeId: string; tabId: string; leafId: string } }
    }
  }
}

/**
 * The pane identity this commit is binding, in the same precedence the commit itself uses to
 * choose `registerPty`'s binding. Returns undefined unless every part is a validated id, so a
 * malformed pane can never be read as another pane's durable predecessor.
 */
export function resolveSpawnObservationSurface(
  ctx: SpawnObservationAdmissionState
): SpawnObservationSurface | undefined {
  const adopted = ctx.result.agentSessionEnsure?.owner.surface
  const candidate = adopted
    ? adopted
    : ctx.stablePaneOwner
      ? {
          worktreeId: ctx.hostSessionBinding?.worktreeId ?? ctx.args.worktreeId,
          tabId: ctx.stablePaneOwner.tabId,
          leafId: ctx.stablePaneOwner.leafId
        }
      : (ctx.hostSessionBinding ?? {
          worktreeId: ctx.args.worktreeId,
          tabId: ctx.args.tabId,
          leafId: ctx.metadataLeafId
        })
  return typeof candidate.worktreeId === 'string' &&
    candidate.worktreeId.length > 0 &&
    typeof candidate.tabId === 'string' &&
    isValidTerminalTabId(candidate.tabId) &&
    typeof candidate.leafId === 'string' &&
    isTerminalLeafId(candidate.leafId)
    ? { worktreeId: candidate.worktreeId, tabId: candidate.tabId, leafId: candidate.leafId }
    : undefined
}

/**
 * Commit-entry preflight. Validates operation ownership and candidate capacity
 * BEFORE any binding mutation and outside the destructive execute/persistence
 * catches, so an overflow reaches the outer spawn wrapper's non-destructive
 * cancellation instead of clearing provider state or killing the PTY.
 *
 * It also reads the pane's durably recorded predecessor incarnation here, while the binding
 * write below has not yet replaced it — the only known-old a relaunched host still has.
 */
export function prepareSpawnObservationAdmission(
  ctx: SpawnObservationAdmissionState
): PreparedPtyObservationAdmission | null {
  const surface = resolveSpawnObservationSurface(ctx)
  return (
    ctx.deps.runtime?.preparePtyObservationAdmission?.(
      ctx.observationAdmissionToken,
      ctx.result.id,
      ctx.result.incarnationId,
      surface
    ) ?? null
  )
}
