/**
 * The local implementation of the office surface, shared verbatim by three callers: this client's
 * own `local` execution host, the SSH relay handler, and the paired runtime's RPC methods. One
 * implementation is the point — a relay that classified refusals differently from the client would
 * make the same document fail two different ways depending on where it lives.
 *
 * "Local" here means *this process's own machine*, which on Windows may still mean a WSL guest:
 * a worktree under `\\wsl$\<distro>\…` is owned by the distro, and its `officecli`, fonts and
 * paths are the guest's. The lane is derived from the document path, not assumed.
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

/** The document path as the lane's own filesystem spells it, plus the lane. */
export type OfficeLaneTarget = { lane: OfficecliLane; documentPath: string }

export function resolveOfficeLaneTarget(documentPath: string): OfficeLaneTarget {
  const wsl = parseWslUncPath(documentPath)
  return wsl
    ? { lane: { kind: 'wsl', distro: wsl.distro }, documentPath: wsl.linuxPath }
    : { lane: NATIVE_OFFICECLI_LANE, documentPath }
}

/**
 * A probe is per-lane, but the caller names a document rather than a lane: on Windows the answer
 * for a WSL worktree and for a drive-letter one are genuinely different installs.
 */
export function probeOfficeForDocument(documentPath?: string): Promise<OfficeProbeOutcome> {
  return probeOfficecli(documentPath ? resolveOfficeLaneTarget(documentPath).lane : undefined)
}

export function invalidateOfficeProbeForDocument(documentPath?: string): void {
  invalidateOfficeProbe(documentPath ? resolveOfficeLaneTarget(documentPath).lane : undefined)
}

export function renderOfficeLocally(documentPath: string): Promise<OfficeRenderOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return renderOfficeDocument(target.documentPath, target.lane)
}

export function startOfficeWatchLocally(documentPath: string): Promise<OfficeWatchOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return startOfficeWatch(target.documentPath, target.lane)
}

export function refreshOfficeWatchLocally(documentPath: string): Promise<OfficeAckOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return refreshOfficeWatch(target.documentPath, target.lane)
}

export function stopOfficeWatchLocally(documentPath: string): Promise<OfficeAckOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return stopOfficeWatch(target.documentPath, target.lane)
}

export function readOfficeSelectionLocally(documentPath: string): Promise<OfficeSelectionOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return readOfficeSelection(target.documentPath, target.lane)
}

export function readOfficeMarksLocally(documentPath: string): Promise<OfficeMarksOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return readOfficeMarks(target.documentPath, target.lane)
}

export function clearOfficeMarksLocally(documentPath: string): Promise<OfficeMarksOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return clearOfficeMarks(target.documentPath, target.lane)
}

export function gotoOfficeElementLocally(
  documentPath: string,
  elementPath: string
): Promise<OfficeAckOutcome> {
  const target = resolveOfficeLaneTarget(documentPath)
  return gotoOfficeElement(target.documentPath, elementPath, target.lane)
}

export function listOfficeSkillsLocally(documentPath?: string): Promise<OfficeSkillCatalogOutcome> {
  return listOfficeSkills(documentPath ? resolveOfficeLaneTarget(documentPath).lane : undefined)
}

export function installOfficeSkillsLocally(
  pairs: readonly { skill: string; agent: string }[],
  documentPath?: string
): Promise<OfficeSkillInstallOutcome> {
  return installOfficeSkills(
    pairs,
    documentPath ? resolveOfficeLaneTarget(documentPath).lane : undefined
  )
}
