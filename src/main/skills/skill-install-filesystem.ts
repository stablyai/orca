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
  /** Discovery-matched mtime: native stat follows links, WSL stat -c %Y does not. Null means unreadable. */
  mtimeMs: number | null
}

export type SkillInstallFilesystem = {
  authorizeRoots?(paths: readonly string[]): void
  /** Optional batch enumeration bounds guest/remote round trips. Delete refuses absent primitives rather than guessing. */
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
  // Bound metadata fan-out across the full discovery root set, as discovery does.
  listEntries: async (directories) =>
    new Map(
      await runSkillCandidateTasks(
        directories.map((directory) => async (): Promise<[string, SkillDirectoryEntry[]]> => {
          // Only proven absence is empty; swallowed EACCES/EIO could authorize removal of an uninspected parent.
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
