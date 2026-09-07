import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'
import { renameSkillPathWithWindowsRetry } from './skill-filesystem-retry'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import {
  SKILL_PACKAGE_OBSERVATION_LIMITS,
  observeSkillPackage,
  type ObservedSkillPackage
} from './skill-package-identity'

export type SkillInstalledFileMode = { path: string; executable: boolean }

/** `lstat` semantics: a symlink is `symlink` whatever it points at. */
export type SkillFilesystemEntryKind = 'directory' | 'file' | 'symlink' | 'other' | 'missing'

export type SkillDirectoryEntry = { name: string; kind: SkillFilesystemEntryKind }

export type SkillPathInspection = {
  kind: SkillFilesystemEntryKind
  /** Fully resolved path; null when it cannot be resolved (broken link, gone). */
  realpath: string | null
  /**
   * Modification time in ms, read the same way the host's own discovery read it
   * so a freshness comparison stays self-consistent: native `stat` (follows a
   * symlink), WSL's `stat -c %Y` (does not). Null when it cannot be read.
   */
  mtimeMs: number | null
}

export type SkillInstallFilesystem = {
  authorizeRoots?(paths: readonly string[]): void
  /**
   * Enumeration primitives for path-based deletion. Both take arrays because a
   * guest or remote filesystem must answer a whole delete plan in one round
   * trip — the WSL home alone contributes ~16 discovery roots, and one
   * `wsl.exe` boot per root is the cost this shape exists to avoid.
   *
   * Optional: only implementations that can enumerate provide them, and the
   * delete service refuses rather than guessing when they are absent.
   */
  listEntries?(directories: readonly string[]): Promise<Map<string, SkillDirectoryEntry[]>>
  inspectPaths?(paths: readonly string[]): Promise<Map<string, SkillPathInspection>>
  prepareExtractedSkill(path: string, manifest: SkillPackageManifestV1): Promise<void>
  observeSkill(
    path: string,
    files?: readonly SkillInstalledFileMode[]
  ): Promise<ObservedSkillPackage>
  rename(source: string, target: string): Promise<void>
  remove(path: string): Promise<void>
  createAlias?(canonicalPath: string, destinationPath: string): Promise<void>
  aliasTargets?(canonicalPath: string, destinationPath: string): Promise<boolean>
}

export const nativeSkillInstallFilesystem: SkillInstallFilesystem = {
  prepareExtractedSkill: async () => undefined,
  observeSkill: (path, files) =>
    observeSkillPackage(
      path,
      SKILL_PACKAGE_OBSERVATION_LIMITS,
      process.platform === 'win32' && files
        ? new Set(files.filter((file) => file.executable).map((file) => file.path))
        : undefined
    ),
  rename: renameSkillPathWithWindowsRetry,
  remove: (path) => rm(path, { recursive: true, force: true }),
  // Why the bounded pool rather than `Promise.all`: a delete plan enumerates
  // every discovery root, and unbounded fan-out here is the same burst of
  // filesystem-metadata work discovery already learned to cap.
  listEntries: async (directories) =>
    new Map(
      await runSkillCandidateTasks(
        directories.map((directory) => async (): Promise<[string, SkillDirectoryEntry[]]> => {
          // Only a confirmed absence may read as an empty directory: the delete
          // planner treats an empty listing as "nothing left here" and removes
          // the parent, so a swallowed EACCES/EIO would delete unenumerated files.
          const entries = await readdir(directory, { withFileTypes: true }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
                return []
              }
              throw error
            }
          )
          return [
            directory,
            entries.map((entry) => ({ name: entry.name, kind: direntKind(entry) }))
          ]
        })
      )
    ),
  inspectPaths: async (paths) =>
    new Map(
      await runSkillCandidateTasks(
        paths.map((path) => async (): Promise<[string, SkillPathInspection]> => [
          path,
          {
            kind: statKind(await lstat(path).catch(() => null)),
            realpath: await realpath(path).catch(() => null),
            mtimeMs: (await stat(path).catch(() => null))?.mtimeMs ?? null
          }
        ])
      )
    )
}

function direntKind(entry: Dirent): SkillFilesystemEntryKind {
  if (entry.isSymbolicLink()) {
    return 'symlink'
  }
  if (entry.isDirectory()) {
    return 'directory'
  }
  return entry.isFile() ? 'file' : 'other'
}

function statKind(value: Stats | null): SkillFilesystemEntryKind {
  if (!value) {
    return 'missing'
  }
  if (value.isSymbolicLink()) {
    return 'symlink'
  }
  if (value.isDirectory()) {
    return 'directory'
  }
  return value.isFile() ? 'file' : 'other'
}
