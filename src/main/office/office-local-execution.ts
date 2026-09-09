/**
 * The local implementation of the office surface, shared verbatim by three callers: this client's
 * own `local` execution host, the SSH relay handler, and the paired runtime's RPC methods. One
 * implementation is the point — a relay that classified refusals differently from the client would
 * make the same document fail two different ways depending on where it lives.
 *
 * "Local" here means *this process's own machine*, which on Windows may still mean a WSL guest:
 * a worktree under `\\wsl$\<distro>\…` is owned by the distro, and its `officecli`, fonts and
 * paths are the guest's. The lane is derived from the workspace root, not assumed.
 *
 * Every document is named as (workspace root, path relative to it). The host joins and
 * canonicalises the two and refuses anything that lands outside the root — so this layer never
 * receives a bare absolute path it would have to trust.
 */
import { parseWslUncPath } from '../../shared/wsl-paths'
import type {
  OfficeAckOutcome,
  OfficeMarksOutcome,
  OfficeProbeOutcome,
  OfficeRenderOutcome,
  OfficeSelectionOutcome,
  OfficeSkillCatalogOutcome,
  OfficeSkillInstallOutcome,
  OfficeWatchOutcome
} from '../../shared/office-preview-contracts'
import { NATIVE_OFFICECLI_LANE, type OfficecliLane } from './officecli-lane'
import { invalidateOfficeProbe, probeOfficecli } from './office-probe-service'
import { renderOfficeDocument } from './office-render-service'
import {
  clearOfficeMarks,
  gotoOfficeElement,
  readOfficeMarks,
  readOfficeSelection
} from './office-selection-service'
import { installOfficeSkills, listOfficeSkills } from './office-skills-service'
import { refreshOfficeWatch } from './office-watch-refresh'
import { startOfficeWatch, stopOfficeWatch } from './office-watch-manager'

/** A document named the way the host will resolve it, on the lane that owns it. */
export type OfficeDocumentRef = {
  lane: OfficecliLane
  /** Workspace root as the lane's own filesystem spells it. */
  workspaceRoot: string
  relativePath: string
}

/** A WSL worktree is owned by the distro: the guest's binary, fonts and POSIX paths, not ours. */
export function resolveOfficeLane(workspaceRoot: string): {
  lane: OfficecliLane
  laneRoot: string
} {
  const wsl = parseWslUncPath(workspaceRoot)
  return wsl
    ? { lane: { kind: 'wsl', distro: wsl.distro }, laneRoot: wsl.linuxPath }
    : { lane: NATIVE_OFFICECLI_LANE, laneRoot: workspaceRoot }
}

export function officeDocumentRef(workspaceRoot: string, relativePath: string): OfficeDocumentRef {
  const { lane, laneRoot } = resolveOfficeLane(workspaceRoot)
  return { lane, workspaceRoot: laneRoot, relativePath }
}

/**
 * A probe is per-lane, but the caller names a workspace rather than a lane: on Windows the answer
 * for a WSL worktree and for a drive-letter one are genuinely different installs.
 */
export function probeOfficeForWorkspace(workspaceRoot?: string): Promise<OfficeProbeOutcome> {
  return probeOfficecli(workspaceRoot ? resolveOfficeLane(workspaceRoot).lane : undefined)
}

export function invalidateOfficeProbeForWorkspace(workspaceRoot?: string): void {
  invalidateOfficeProbe(workspaceRoot ? resolveOfficeLane(workspaceRoot).lane : undefined)
}

export function renderOfficeLocally(ref: OfficeDocumentRef): Promise<OfficeRenderOutcome> {
  return renderOfficeDocument(ref)
}

export function startOfficeWatchLocally(ref: OfficeDocumentRef): Promise<OfficeWatchOutcome> {
  return startOfficeWatch(ref)
}

export function refreshOfficeWatchLocally(ref: OfficeDocumentRef): Promise<OfficeAckOutcome> {
  return refreshOfficeWatch(ref)
}

export function stopOfficeWatchLocally(ref: OfficeDocumentRef): Promise<OfficeAckOutcome> {
  return stopOfficeWatch(ref)
}

export function readOfficeSelectionLocally(
  ref: OfficeDocumentRef
): Promise<OfficeSelectionOutcome> {
  return readOfficeSelection(ref)
}

export function readOfficeMarksLocally(ref: OfficeDocumentRef): Promise<OfficeMarksOutcome> {
  return readOfficeMarks(ref)
}

export function clearOfficeMarksLocally(ref: OfficeDocumentRef): Promise<OfficeMarksOutcome> {
  return clearOfficeMarks(ref)
}

export function gotoOfficeElementLocally(
  ref: OfficeDocumentRef,
  elementPath: string
): Promise<OfficeAckOutcome> {
  return gotoOfficeElement(ref, elementPath)
}

export function listOfficeSkillsLocally(
  workspaceRoot?: string
): Promise<OfficeSkillCatalogOutcome> {
  return listOfficeSkills(workspaceRoot ? resolveOfficeLane(workspaceRoot).lane : undefined)
}

export function installOfficeSkillsLocally(
  pairs: readonly { skill: string; agent: string }[],
  workspaceRoot?: string
): Promise<OfficeSkillInstallOutcome> {
  return installOfficeSkills(
    pairs,
    workspaceRoot ? resolveOfficeLane(workspaceRoot).lane : undefined
  )
}
