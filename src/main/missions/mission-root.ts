import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import path from 'node:path'
import { getMissionRootDirName } from '../../shared/missions'
import { writeMissionRootMarkerFile } from './mission-root-marker-write'

export const MISSIONS_DIR_NAME = 'missions'
const MISSION_ROOT_MARKER_NAME = '.orca-mission-root.json'
const MISSION_ROOT_MARKER_VERSION = 1

type MissionRootMarker = { version: 1; missionId: string; links: MissionRootLink[] }
export type MissionRootLink = { name: string; targetPath: string }
export type RemoveMissionRootResult = { removed: boolean; preservedEntries: string[] }

export function resolveMissionsBaseDir(workspaceDir: string, homeDir: string): string {
  if (path.isAbsolute(workspaceDir)) {
    return path.join(path.dirname(workspaceDir), MISSIONS_DIR_NAME)
  }
  return path.join(homeDir, 'orca', MISSIONS_DIR_NAME)
}

// Why: a stable ID suffix prevents concurrent same-name missions from sharing a root.
export function resolveMissionRootPath(
  baseDir: string,
  missionName: string,
  missionId: string
): string {
  const slug = getMissionRootDirName(missionName).slice(0, 80)
  const idSuffix = createHash('sha256').update(missionId).digest('hex').slice(0, 12)
  return path.join(baseDir, `${slug}-${idSuffix}`)
}

function missionPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function assertMissionRootInBase(baseDir: string, rootPath: string): void {
  const resolvedRoot = path.resolve(rootPath)
  const hasTrustedParent = missionPathKey(path.dirname(resolvedRoot)) === missionPathKey(baseDir)
  if (rootPath !== resolvedRoot || !hasTrustedParent) {
    throw new Error('mission_root_outside_trusted_base')
  }
}

function lstatOrNull(entryPath: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(entryPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function assertMissionRootDirectory(rootPath: string): void {
  const stat = lstatOrNull(rootPath)
  if (stat?.isSymbolicLink()) {
    throw new Error('mission_root_is_link')
  }
  if (stat && !stat.isDirectory()) {
    throw new Error('mission_root_not_directory')
  }
}

function assertMissionLinkName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name === MISSION_ROOT_MARKER_NAME ||
    path.basename(name) !== name ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error('mission_root_invalid_link_name')
  }
}

function parseMissionRootMarker(rootPath: string, missionId: string): MissionRootMarker {
  const markerPath = path.join(rootPath, MISSION_ROOT_MARKER_NAME)
  const markerStat = lstatOrNull(markerPath)
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('mission_root_unowned')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    throw new Error('mission_root_invalid_marker')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('mission_root_invalid_marker')
  }
  const marker = parsed as Partial<MissionRootMarker>
  if (marker.version !== MISSION_ROOT_MARKER_VERSION || !Array.isArray(marker.links)) {
    throw new Error('mission_root_invalid_marker')
  }
  if (marker.missionId !== missionId) {
    throw new Error('mission_root_owned_by_another_mission')
  }

  const links: MissionRootLink[] = []
  const names = new Set<string>()
  for (const link of marker.links) {
    if (
      !link ||
      typeof link.name !== 'string' ||
      typeof link.targetPath !== 'string' ||
      !path.isAbsolute(link.targetPath) ||
      names.has(link.name)
    ) {
      throw new Error('mission_root_invalid_marker')
    }
    try {
      assertMissionLinkName(link.name)
    } catch {
      throw new Error('mission_root_invalid_marker')
    }
    names.add(link.name)
    links.push({ name: link.name, targetPath: link.targetPath })
  }
  return { version: MISSION_ROOT_MARKER_VERSION, missionId, links }
}

/** Prove that an existing Mission root is the exact non-link directory Orca owns. */
export function assertOwnedMissionRoot(args: {
  baseDir: string
  rootPath: string
  missionId: string
}): void {
  assertMissionRootInBase(args.baseDir, args.rootPath)
  const rootStat = lstatOrNull(args.rootPath)
  if (!rootStat) {
    throw new Error('mission_root_unowned')
  }
  assertMissionRootDirectory(args.rootPath)
  parseMissionRootMarker(args.rootPath, args.missionId)
}

function writeMissionRootMarker(rootPath: string, marker: MissionRootMarker): void {
  writeMissionRootMarkerFile(path.join(rootPath, MISSION_ROOT_MARKER_NAME), JSON.stringify(marker))
}

function ensureOwnedMissionRoot(
  baseDir: string,
  rootPath: string,
  missionId: string
): MissionRootMarker {
  assertMissionRootInBase(baseDir, rootPath)
  mkdirSync(baseDir, { recursive: true })
  assertMissionRootDirectory(rootPath)
  if (!lstatOrNull(rootPath)) {
    try {
      mkdirSync(rootPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
  // Why: an EEXIST race could have installed a junction after the first check.
  assertMissionRootDirectory(rootPath)

  const entries = readdirSync(rootPath)
  if (entries.length === 0) {
    const marker: MissionRootMarker = {
      version: MISSION_ROOT_MARKER_VERSION,
      missionId,
      links: []
    }
    writeMissionRootMarker(rootPath, marker)
    return marker
  }
  return parseMissionRootMarker(rootPath, missionId)
}

// Why: normalize Windows junction decoration to avoid recreating unchanged links.
function isSameLinkTarget(currentTarget: string, wantedTarget: string): boolean {
  const normalize = (target: string): string => path.resolve(target.replace(/^\\\\\?\\/, ''))
  return missionPathKey(normalize(currentTarget)) === missionPathKey(normalize(wantedTarget))
}

function readMissionLinkTarget(linkPath: string): string | null {
  const stat = lstatOrNull(linkPath)
  if (!stat?.isSymbolicLink()) {
    return null
  }
  try {
    return readlinkSync(linkPath)
  } catch {
    return null
  }
}

/** Sync Orca-owned links while preserving untracked links and regular entries. */
export function ensureMissionRoot(args: {
  baseDir: string
  rootPath: string
  missionId: string
  links: MissionRootLink[]
}): void {
  const marker = ensureOwnedMissionRoot(args.baseDir, args.rootPath, args.missionId)
  const previousByName = new Map(marker.links.map((link) => [link.name, link.targetPath]))
  const wantedByName = new Map<string, string>()
  for (const link of args.links) {
    assertMissionLinkName(link.name)
    if (!path.isAbsolute(link.targetPath)) {
      throw new Error('mission_root_target_not_absolute')
    }
    if (wantedByName.has(link.name)) {
      throw new Error('mission_root_duplicate_link_name')
    }
    wantedByName.set(link.name, link.targetPath)
  }

  for (const [name, previousTarget] of previousByName) {
    if (wantedByName.has(name)) {
      continue
    }
    const linkPath = path.join(args.rootPath, name)
    const currentTarget = readMissionLinkTarget(linkPath)
    // Why: a replaced link is no longer demonstrably Orca-owned; preserve it.
    if (currentTarget !== null && isSameLinkTarget(currentTarget, previousTarget)) {
      unlinkSync(linkPath)
    }
  }

  const nextLinks: MissionRootLink[] = []
  for (const [name, targetPath] of wantedByName) {
    const linkPath = path.join(args.rootPath, name)
    const currentStat = lstatOrNull(linkPath)
    const currentTarget = readMissionLinkTarget(linkPath)
    const previousTarget = previousByName.get(name)
    if (!existsSync(targetPath)) {
      if (
        currentTarget !== null &&
        previousTarget &&
        isSameLinkTarget(currentTarget, previousTarget)
      ) {
        unlinkSync(linkPath)
      }
      continue
    }
    if (currentTarget !== null && isSameLinkTarget(currentTarget, targetPath)) {
      nextLinks.push({ name, targetPath })
      continue
    }
    if (
      currentTarget !== null &&
      previousTarget &&
      isSameLinkTarget(currentTarget, previousTarget)
    ) {
      unlinkSync(linkPath)
    } else if (currentStat) {
      throw new Error(`mission_root_link_name_conflict:${name}`)
    }
    // Why: Windows directory links need elevation unless created as junctions.
    symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    nextLinks.push({ name, targetPath })
  }

  writeMissionRootMarker(args.rootPath, {
    version: MISSION_ROOT_MARKER_VERSION,
    missionId: args.missionId,
    links: nextLinks
  })
}

/** Remove only links whose marker ownership and target still match. */
export function removeMissionRoot(args: {
  baseDir: string
  rootPath: string
  missionId: string
}): RemoveMissionRootResult {
  assertMissionRootInBase(args.baseDir, args.rootPath)
  const rootStat = lstatOrNull(args.rootPath)
  if (!rootStat) {
    return { removed: true, preservedEntries: [] }
  }
  assertMissionRootDirectory(args.rootPath)
  const marker = parseMissionRootMarker(args.rootPath, args.missionId)

  for (const link of marker.links) {
    const linkPath = path.join(args.rootPath, link.name)
    const currentTarget = readMissionLinkTarget(linkPath)
    if (currentTarget !== null && isSameLinkTarget(currentTarget, link.targetPath)) {
      unlinkSync(linkPath)
    }
  }
  const preservedEntries = readdirSync(args.rootPath)
    .filter((entry) => entry !== MISSION_ROOT_MARKER_NAME)
    .sort()
  if (preservedEntries.length > 0) {
    // Why: a crash may reload the still-persisted Mission; retain ownership of
    // a non-empty physical root while releasing its legacy managed links.
    writeMissionRootMarker(args.rootPath, {
      version: MISSION_ROOT_MARKER_VERSION,
      missionId: args.missionId,
      links: []
    })
    return { removed: false, preservedEntries }
  }
  unlinkSync(path.join(args.rootPath, MISSION_ROOT_MARKER_NAME))
  rmdirSync(args.rootPath)
  return { removed: true, preservedEntries: [] }
}
