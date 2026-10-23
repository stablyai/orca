import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { BUNDLED_SKILL_OLD_MARKER, BUNDLED_SKILL_STAGE_MARKER } from '../skill-delete/staging-names'
import type { BundledSkillFilesystem } from './filesystem'

export type BundledSkillFile = { path: string; text: string }

/** Thrown when a path no longer holds what the plan observed; nothing was moved. */
export class BundledSkillChangedError extends Error {
  constructor(path: string) {
    super(`bundled-skill-changed: ${path}`)
  }
}

export function bundledSkillSiblingKind(name: string, entryName: string): 'stage' | 'old' | null {
  if (entryName.startsWith(`.${name}${BUNDLED_SKILL_STAGE_MARKER}`)) {
    return 'stage'
  }
  return entryName.startsWith(`.${name}${BUNDLED_SKILL_OLD_MARKER}`) ? 'old' : null
}

function siblingPath(target: string, marker: string): string {
  return join(dirname(target), `.${basename(target)}${marker}${randomUUID()}`)
}

/**
 * One place per executing host, outside every skills root (agents would load it) and outside
 * any project (it would show up in the repo).
 */
export function bundledSkillBackupPath(homeDirectory: string, name: string): string {
  const utc = new Date().toISOString().replace(/[:.]/gu, '-')
  return join(homeDirectory, '.agents', '.orca-skill-backups', `${name}-${utc}-${randomUUID()}`)
}

/** The installer's only delete: it refuses anything but its own stage and old siblings. */
export async function removeBundledSkillSibling(
  filesystem: BundledSkillFilesystem,
  path: string
): Promise<void> {
  const name = basename(path)
  const owner = /^\.(.+?)\.orca-(?:stage|old)-/u.exec(name)?.[1]
  if (!owner || !bundledSkillSiblingKind(owner, name)) {
    throw new Error(`bundled-skill-refused-delete: ${path}`)
  }
  await filesystem.remove(path)
}

async function stage(
  filesystem: BundledSkillFilesystem,
  target: string,
  files: readonly BundledSkillFile[]
): Promise<string> {
  const staged = siblingPath(target, BUNDLED_SKILL_STAGE_MARKER)
  try {
    await filesystem.writeFolder(staged, files)
  } catch (error) {
    await removeBundledSkillSibling(filesystem, staged).catch(() => undefined)
    throw error
  }
  return staged
}

async function requireUnchanged(verify: () => Promise<boolean>, path: string): Promise<void> {
  if (!(await verify())) {
    throw new BundledSkillChangedError(path)
  }
}

/** `write` / `copy`: stage beside the empty slot, then rename in. */
export async function putBundledSkillFolder(
  filesystem: BundledSkillFilesystem,
  target: string,
  files: readonly BundledSkillFile[],
  verify: () => Promise<boolean>
): Promise<void> {
  const staged = await stage(filesystem, target, files)
  try {
    await requireUnchanged(verify, target)
    await filesystem.rename(staged, target)
  } catch (error) {
    await removeBundledSkillSibling(filesystem, staged).catch(() => undefined)
    throw error
  }
}

/**
 * `update`: two renames, since POSIX cannot atomically replace a non-empty folder. A crash
 * between them leaves `.orca-old` beside a missing target, which the next plan restores.
 * Returns the old copy's path for the caller to re-check and settle.
 */
export async function swapBundledSkillFolder(
  filesystem: BundledSkillFilesystem,
  target: string,
  files: readonly BundledSkillFile[],
  verify: () => Promise<boolean>
): Promise<string> {
  const staged = await stage(filesystem, target, files)
  const old = siblingPath(target, BUNDLED_SKILL_OLD_MARKER)
  try {
    await requireUnchanged(verify, target)
    await filesystem.rename(target, old)
  } catch (error) {
    await removeBundledSkillSibling(filesystem, staged).catch(() => undefined)
    throw error
  }
  try {
    await filesystem.rename(staged, target)
  } catch (error) {
    await filesystem.rename(old, target).catch(() => undefined)
    await removeBundledSkillSibling(filesystem, staged).catch(() => undefined)
    throw error
  }
  return old
}

/**
 * `replace`: the foreign object (a link moves as itself, never what it points to) goes to
 * backups before anything takes its place, so no `.orca-old` holds user content.
 */
export async function replaceBundledSkillPath(
  filesystem: BundledSkillFilesystem,
  target: string,
  backupPath: string,
  put: { files: readonly BundledSkillFile[] } | { linkTarget: string },
  verify: () => Promise<boolean>
): Promise<void> {
  const { staged, placeNew } =
    'files' in put
      ? await stage(filesystem, target, put.files).then((path) => ({
          staged: path,
          placeNew: () => filesystem.rename(path, target)
        }))
      : { staged: null, placeNew: () => filesystem.createLink(put.linkTarget, target) }
  const dropStaged = () =>
    staged ? removeBundledSkillSibling(filesystem, staged).catch(() => undefined) : undefined
  try {
    await filesystem.ensureDirectory(dirname(backupPath))
    await requireUnchanged(verify, target)
    await filesystem.moveToBackup(target, backupPath)
  } catch (error) {
    await dropStaged()
    throw error
  }
  try {
    await placeNew()
  } catch (error) {
    await filesystem.moveToBackup(backupPath, target).catch(() => undefined)
    await dropStaged()
    throw error
  }
}

/** Moves a non-released leftover aside; returns where it went. */
export async function backUpBundledSkillPath(
  filesystem: BundledSkillFilesystem,
  path: string,
  backupPath: string
): Promise<string> {
  await filesystem.ensureDirectory(dirname(backupPath))
  await filesystem.moveToBackup(path, backupPath)
  return backupPath
}
