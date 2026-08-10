import type { Dirent } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import { SKILL_DISCOVERY_LIMITS, type DiscoveredSkill } from '../../shared/skills'
import {
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId,
  type SkillScanRoot
} from './skill-discovery-sources'

const MAX_MARKDOWN_BYTES = 256 * 1024
const MAX_SKILL_FILES = 200

export type ScannedSkill = DiscoveredSkill & { canonicalSkillFilePath: string }

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Skill discovery aborted')
    error.name = 'AbortError'
    throw error
  }
}

async function countFiles(dirPath: string, signal?: AbortSignal): Promise<number> {
  let count = 0
  const visitedDirectoryPaths = new Set<string>()
  async function visit(currentPath: string): Promise<void> {
    throwIfAborted(signal)
    if (count >= MAX_SKILL_FILES) {
      return
    }
    let resolvedPath: string
    try {
      resolvedPath = await realpath(currentPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedPath)

    let entries: Dirent[]
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= MAX_SKILL_FILES) {
        return
      }
      const entryPath = join(currentPath, entry.name)
      if (entry.isFile()) {
        count += 1
      } else if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(entryPath)).isFile()) {
            count += 1
          }
        } catch {
          // Broken links do not contribute to the skill package file count.
        }
      }
    }
  }
  await visit(dirPath)
  return count
}

async function readSkillSummary(skillFilePath: string): Promise<{
  name: string | null
  description: string | null
  updatedAt: number | null
} | null> {
  try {
    const fileStat = await stat(skillFilePath)
    const file = await open(skillFilePath, 'r')
    let content = ''
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_MARKDOWN_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      content = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    return { ...summarizeSkillMarkdown(content), updatedAt: fileStat.mtimeMs }
  } catch {
    return null
  }
}

export async function scanSkillFile(
  root: SkillScanRoot,
  skillFilePath: string,
  signal?: AbortSignal
): Promise<ScannedSkill | null> {
  throwIfAborted(signal)
  const canonicalSkillFilePath = await realpath(skillFilePath).catch(() => skillFilePath)
  const directoryPath = dirname(skillFilePath)
  if (
    directoryPath.length > SKILL_DISCOVERY_LIMITS.pathLength ||
    skillFilePath.length > SKILL_DISCOVERY_LIMITS.pathLength
  ) {
    return null
  }
  const summary = await readSkillSummary(skillFilePath)
  if (!summary) {
    return null
  }
  const sourceKind = sourceKindForSkill(root, skillFilePath, { relative, sep })
  return {
    id: stablePathId(canonicalSkillFilePath),
    name: (summary.name ?? basename(directoryPath)).slice(0, SKILL_DISCOVERY_LIMITS.nameLength),
    description: summary.description?.slice(0, SKILL_DISCOVERY_LIMITS.descriptionLength) ?? null,
    providers: [...root.providers],
    sourceKind,
    sourceLabel: sourceLabelForSkill(root, sourceKind),
    rootPath: root.path,
    directoryPath,
    skillFilePath,
    installed: true,
    fileCount: await countFiles(directoryPath, signal),
    updatedAt: summary.updatedAt,
    canonicalSkillFilePath
  }
}
