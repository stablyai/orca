export const BUNDLED_SKILL_STAGE_MARKER = '.orca-stage-'

export const BUNDLED_SKILL_OLD_MARKER = '.orca-old-'

import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

import type { BundledSkillBackupRefusal } from '../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'
import { filesystemErrorCode } from './bundled-skill-filesystem-error'

export type BundledSkillFile = { path: string; text: string }

/** Thrown when a path no longer holds what the plan observed; nothing was moved. */
export class BundledSkillChangedError extends Error {
  constructor(path: string) {
    super(`bundled-skill-changed: ${path}`)
  }
}

export class BundledSkillBackupRefusedError extends Error {
  constructor(readonly refusal: BundledSkillBackupRefusal) {
    super(`Cross-drive skill backup refused: ${refusal.path}`)
  }
}

export class BundledSkillReplaceRestoreError extends Error {
  constructor(
    readonly backupPath: string,
    cause: unknown
  ) {
    super(`Skill replacement failed; original preserved at ${backupPath}`, { cause })
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

export async function retireBundledSkillPlacement(
  filesystem: BundledSkillFilesystem,
  path: string,
  forwardTo: string | undefined,
  verify: (path: string) => Promise<boolean>,
  backupPath: string
): Promise<string | undefined> {
  await requireUnchanged(() => verify(path), path)
  const old = siblingPath(path, BUNDLED_SKILL_OLD_MARKER)
  await filesystem.rename(path, old)
  if (!(await verify(old))) {
    await filesystem.rename(old, path)
    throw new BundledSkillChangedError(path)
  }
  try {
    if (forwardTo) {
      await filesystem.createLink(forwardTo, path)
    }
  } catch (error) {
    await filesystem.rename(old, path).catch(() => undefined)
    throw error
  }
  if (!(await verify(old))) {
    try {
      return await backUpBundledSkillPath(filesystem, old, backupPath, 'moved-aside')
    } catch (error) {
      if (!forwardTo && error instanceof BundledSkillBackupRefusedError) {
        await putBackRefusedCopy(filesystem, old, path)
      }
      throw error
    }
  }
  await removeBundledSkillSibling(filesystem, old)
  return undefined
}

/**
 * A refused retirement with no forwarding link puts the edited copy back where the user left it.
 * Best effort, like Replace's rollback: a check, then a rename. Throws the in-place refusal on
 * success; returns when the copy must stay at `old`. Later plans may not list a retired place
 * (a former root is never planned), so this result is the copy's only notice.
 */
async function putBackRefusedCopy(
  filesystem: BundledSkillFilesystem,
  old: string,
  path: string
): Promise<void> {
  try {
    if ((await filesystem.stat(path))?.kind !== 'missing') {
      return
    }
    await filesystem.rename(old, path)
  } catch {
    return
  }
  throw new BundledSkillBackupRefusedError({ path, source: 'in-place', onlyNotice: true })
}

/** Backups stay outside skill roots (agents would load them) and projects (they would pollute repos). */
export function bundledSkillBackupDirectory(homeDirectory: string): string {
  return join(homeDirectory, '.agents', '.orca-skill-backups')
}

export function bundledSkillBackupPath(homeDirectory: string, name: string): string {
  const utc = new Date().toISOString().replace(/[:.]/gu, '-')
  return join(bundledSkillBackupDirectory(homeDirectory), `${name}-${utc}-${randomUUID()}`)
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

/** POSIX cannot replace a nonempty directory atomically; an interrupted two-rename update leaves .orca-old for the next plan to restore. Return old copy for rechecking. */
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

/** Back up the foreign object itself before replacement; never put user content in disposable .orca-old siblings. */
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
    await renameToBackup(filesystem, target, backupPath, 'in-place')
  } catch (error) {
    await dropStaged()
    throw error
  }
  try {
    await placeNew()
  } catch (error) {
    await dropStaged()
    try {
      if ((await filesystem.stat(target))?.kind !== 'missing') {
        throw new BundledSkillChangedError(target)
      }
      await filesystem.rename(backupPath, target)
    } catch {
      throw new BundledSkillReplaceRestoreError(backupPath, error)
    }
    throw error
  }
  // Only after placement, so a rolled-back original keeps its own mode.
  await privatizeQuietly(filesystem, backupPath)
}

async function renameToBackup(
  filesystem: BundledSkillFilesystem,
  path: string,
  backupPath: string,
  source: BundledSkillBackupRefusal['source']
): Promise<void> {
  try {
    await filesystem.rename(path, backupPath)
  } catch (error) {
    if (filesystemErrorCode(error) === 'EXDEV') {
      throw new BundledSkillBackupRefusedError({ path, source })
    }
    throw error
  }
}

/** The backups folder is already private, so a failed tightening must not strand a copy that moved. */
async function privatizeQuietly(filesystem: BundledSkillFilesystem, backupPath: string) {
  await filesystem.privatizeBackup(backupPath).catch(() => undefined)
}

export async function backUpBundledSkillPath(
  filesystem: BundledSkillFilesystem,
  path: string,
  backupPath: string,
  source: 'leftover' | 'moved-aside'
): Promise<string> {
  await filesystem.ensureDirectory(dirname(backupPath))
  await renameToBackup(filesystem, path, backupPath, source)
  await privatizeQuietly(filesystem, backupPath)
  return backupPath
}
