import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'
import type { AddWorktreeOptions } from './git/worktree'
import { measureRetargetDivergence } from './git/worktree-base-divergence'
import { resolveLocalWorktreeBaseRef } from './git/worktree-base-ref-probe'
import { preparationPathKey, selectPreparationForCreate } from './worktree-create-preparation-claim'
import {
  listPreparations,
  takePreparation,
  type PreparationClaim,
  type PreparationEntry
} from './worktree-create-preparation-pool'

export function canonicalBaseRef(
  repoPath: string,
  baseBranch: string,
  options: AddWorktreeOptions
): Promise<string> {
  return resolveLocalWorktreeBaseRef(repoPath, baseBranch, {
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  })
}

export type ReservedPreparation = {
  entry: PreparationEntry
  reservation: PreparationClaim
  retargeted: boolean
  canonicalBase: string
}

export async function reservePreparation(
  request: { repoPath: string; workspaceRoot: string; baseBranch: string },
  options: AddWorktreeOptions
): Promise<
  | ({ status: 'reserved' } & ReservedPreparation)
  | { status: 'miss'; reason: PreparedCheckoutMissReason }
> {
  const key = {
    repoPathKey: preparationPathKey(request.repoPath),
    workspaceRootKey: preparationPathKey(request.workspaceRoot),
    wslDistro: options.wslDistro ?? '',
    baseBranch: request.baseBranch
  }
  let selection = selectPreparationForCreate(listPreparations(), { ...key, canonicalBase: null })
  if (selection.kind === 'needs-canonical-base') {
    // Re-read after yielding, then select and take synchronously to avoid duplicate claims.
    const canonicalBase = await canonicalBaseRef(request.repoPath, request.baseBranch, options)
    selection = selectPreparationForCreate(listPreparations(), { ...key, canonicalBase })
  }
  if (selection.kind !== 'exact' && selection.kind !== 'retarget') {
    return {
      status: 'miss',
      reason: selection.kind === 'miss' ? selection.reason : 'base_mismatch'
    }
  }
  if (selection.kind === 'retarget') {
    const candidate = selection.candidate
    const { canonicalBase } = selection
    const divergence = await measureRetargetDivergence(
      request.repoPath,
      candidate.canonicalBase,
      canonicalBase,
      {
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
        ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      }
    )
    if (divergence !== 'within') {
      return {
        status: 'miss',
        reason: divergence === 'exceeded' ? 'retarget_too_divergent' : 'retarget_unverifiable'
      }
    }
    // Recheck after the walk; a different retarget candidate has not passed divergence validation.
    selection = selectPreparationForCreate(listPreparations(), { ...key, canonicalBase })
    if (selection.kind === 'miss' || selection.kind === 'needs-canonical-base') {
      return { status: 'miss', reason: 'base_mismatch' }
    }
    if (selection.kind === 'retarget' && selection.candidate !== candidate) {
      return { status: 'miss', reason: 'base_mismatch' }
    }
  }
  const entry = selection.candidate
  return {
    status: 'reserved',
    entry,
    reservation: takePreparation(entry, selection.canonicalBase),
    retargeted: selection.kind === 'retarget',
    canonicalBase: selection.canonicalBase
  }
}
