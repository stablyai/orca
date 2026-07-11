import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import path from 'node:path'
import { getMissionRootDirName } from '../../shared/missions'

export const MISSIONS_DIR_NAME = 'missions'

/** Missions root lives beside the workspaces tree so both stay under one
 *  Orca-owned parent; repo-relative workspaceDir settings fall back to the
 *  canonical home location. */
export function resolveMissionsBaseDir(workspaceDir: string, homeDir: string): string {
  if (path.isAbsolute(workspaceDir)) {
    return path.join(path.dirname(workspaceDir), MISSIONS_DIR_NAME)
  }
  return path.join(homeDir, 'orca', MISSIONS_DIR_NAME)
}

export function resolveMissionRootPath(baseDir: string, missionName: string): string {
  const dirName = getMissionRootDirName(missionName)
  let candidate = path.join(baseDir, dirName)
  for (let suffix = 2; existsSync(candidate); suffix += 1) {
    candidate = path.join(baseDir, `${dirName}-${suffix}`)
  }
  return candidate
}

export type MissionRootLink = {
  name: string
  targetPath: string
}

function isSymlink(entryPath: string): boolean {
  try {
    return lstatSync(entryPath).isSymbolicLink()
  } catch {
    return false
  }
}

/** Idempotently sync the mission root: one symlink per local member worktree.
 *  Only symlinks are ever created, repointed, or removed — regular entries a
 *  user placed in the root are left alone. */
export function ensureMissionRoot(args: { rootPath: string; links: MissionRootLink[] }): void {
  mkdirSync(args.rootPath, { recursive: true })
  const wantedByName = new Map(args.links.map((link) => [link.name, link.targetPath]))

  for (const entry of readdirSync(args.rootPath)) {
    const entryPath = path.join(args.rootPath, entry)
    if (!isSymlink(entryPath)) {
      continue
    }
    const wantedTarget = wantedByName.get(entry)
    const currentTarget = (() => {
      try {
        return readlinkSync(entryPath)
      } catch {
        return null
      }
    })()
    const targetAlive = currentTarget !== null && existsSync(entryPath)
    if (wantedTarget && currentTarget === wantedTarget && targetAlive) {
      wantedByName.delete(entry)
      continue
    }
    // Why: stale (member removed), broken (worktree deleted), or wrong-target
    // links are all recreated from scratch below.
    unlinkSync(entryPath)
  }

  for (const [name, targetPath] of wantedByName) {
    if (!existsSync(targetPath)) {
      continue
    }
    const linkPath = path.join(args.rootPath, name)
    if (existsSync(linkPath) || isSymlink(linkPath)) {
      continue
    }
    // Why: junctions work for directories on Windows without elevation;
    // POSIX platforms ignore the type argument.
    symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

/** Delete a mission root. Refuses paths outside a `missions` parent so a
 *  corrupted rootPath can never fan out into an arbitrary rm -rf. */
export function removeMissionRoot(rootPath: string): void {
  if (path.basename(path.dirname(rootPath)) !== MISSIONS_DIR_NAME) {
    throw new Error('mission_root_outside_missions_dir')
  }
  rmSync(rootPath, { recursive: true, force: true })
}
