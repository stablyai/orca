import {
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName
} from './worktree-create-candidates'
import type { RetiredNameRegistry } from '../shared/worktree/retired-name-registry'
import { createRetiredNameLookup } from '../shared/worktree/retired-name-registry'

export type WorktreeCreateNameCandidate = {
  /** Filesystem-safe name; drives the workspace path and branch. */
  sanitizedName: string
  /** Display name the workspace is labelled with. */
  requestedName: string
}

export type WorktreeCreateNamePlan = {
  /** True when the created name must be recorded as spent once creation commits. */
  readonly retiresCreatedName: boolean
  /** Null when this suffix lands on a retired cwd; the caller skips it without spending an attempt. */
  candidateAt(suffix: number): WorktreeCreateNameCandidate | null
}

export type WorktreeCreateNamePlanArgs = {
  sanitizedName: string
  /** The raw name the caller asked for; empty falls back to the sanitized candidate. */
  requestedName: string
  /** `true` only from clients that know the name came from the creature-name generator. Every
   *  producer strips it when false, so absent means typed — from a current client as much as an
   *  older one — and must be read that way. */
  nameWasGenerated: boolean | undefined
  loadRetiredNames: () => Promise<RetiredNameRegistry>
}

/** Resolves what a create attempt may call itself, shared by the three create paths (local IPC, SSH,
 *  runtime) so a retirement rule cannot hold on one and not the others.
 *
 *  Two decisions, deliberately split — PR #14350 conflated them, and STA-4471 is the fallout:
 *
 *  - *Which cwds a create may land on* follows the client's `nameWasGenerated` bit. A generated name
 *    is one of ours: nothing was chosen, so folding it onto the canonical tier ladder and stepping
 *    over cwds this host already spent costs the user nothing and keeps the previous occupant's
 *    Claude/Codex history out of the new workspace. A name the user typed is a request — it keeps
 *    its literal spelling, its plain `-2`, `-3` suffixes, and the cwd it asked for even when that
 *    cwd is retired. Asking for `nautilus` and silently getting `nautilus-2` is the worse surprise.
 *  - *Whether the created name is recorded as spent* is decided by the host alone, from the name's
 *    shape. A client that predates the provenance bit still hands back pool-shaped names, and a
 *    registry that never learns about them lets the next generated create collide with one.
 *    `addRetiredWorktreeName` self-gates on pool shape, so a coined name (`fix-login`) is never
 *    recorded — recording is only ever a write, and never redirects anybody.
 *
 *  Only the generated ladder reads the registry, so a typed name and a name outside the pool alike
 *  skip the load — and with it `ensureRetiredWorktreeNamesBackfilled`'s scan (STA-4473). */
export async function planWorktreeCreateNames(
  args: WorktreeCreateNamePlanArgs
): Promise<WorktreeCreateNamePlan> {
  const isPoolShaped = isGeneratedWorktreeCreateName(args.sanitizedName)
  const usesGeneratedLadder = args.nameWasGenerated === true && isPoolShaped
  // Only the generated ladder reads the registry, so a typed name skips the load and its backfill.
  const registry = usesGeneratedLadder ? await args.loadRetiredNames() : null
  const isRetiredName = registry ? createRetiredNameLookup(registry) : null
  const trimmedRequestedName = args.requestedName.trim()
  return {
    retiresCreatedName: isPoolShaped,
    candidateAt(suffix) {
      // Skipping is pure string math, so a run of retired tiers costs no I/O and no attempt budget.
      const sanitizedName = usesGeneratedLadder
        ? getGeneratedWorktreeCreateCandidate(args.sanitizedName, suffix, registry?.exhaustedTiers)
        : getWorktreeCreateCandidate(args.sanitizedName, suffix)
      if (isRetiredName?.(sanitizedName)) {
        return null
      }
      return {
        sanitizedName,
        requestedName:
          !usesGeneratedLadder && trimmedRequestedName
            ? getWorktreeCreateCandidate(args.requestedName, suffix)
            : sanitizedName
      }
    }
  }
}
