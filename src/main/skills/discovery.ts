import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Repo } from '../../shared/types'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillProvider,
  SkillSourceKind
} from '../../shared/skills'

type SkillScanRoot = Omit<SkillDiscoverySource, 'exists' | 'skippedReason'>

const SKILL_FILE_NAME = 'SKILL.md'
const MAX_MARKDOWN_BYTES = 256 * 1024
const MAX_SKILL_FILES = 200

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

function stableId(pathValue: string): string {
  return createHash('sha1').update(pathValue).digest('hex').slice(0, 16)
}

function compareSkills(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.sourceLabel.localeCompare(b.sourceLabel, undefined, { sensitivity: 'base' }) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

function isWithinDepth(rootPath: string, childPath: string, maxDepth: number): boolean {
  const rel = relative(rootPath, childPath)
  if (!rel || rel.startsWith('..')) {
    return true
  }
  return rel.split(sep).length <= maxDepth
}

function sourceKindForSkill(root: SkillScanRoot, skillFilePath: string): SkillSourceKind {
  if (
    root.sourceKind === 'home' &&
    relative(root.path, skillFilePath).split(sep)[0] === '.system'
  ) {
    return 'bundled'
  }
  return root.sourceKind
}

function sourceLabelForSkill(root: SkillScanRoot, sourceKind: SkillSourceKind): string {
  if (sourceKind === 'bundled') {
    return `${root.label} bundled`
  }
  return root.label
}

async function findSkillFiles(rootPath: string, maxDepth: number): Promise<string[]> {
  const out: string[] = []
  async function visit(dirPath: string): Promise<void> {
    if (!isWithinDepth(rootPath, dirPath, maxDepth)) {
      return
    }
    let entries: Dirent[]
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name)
      if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
        out.push(entryPath)
        continue
      }
      if (entry.isDirectory()) {
        await visit(entryPath)
      }
    }
  }
  await visit(rootPath)
  return out
}

async function countFiles(dirPath: string): Promise<number> {
  let count = 0
  async function visit(currentPath: string): Promise<void> {
    if (count >= MAX_SKILL_FILES) {
      return
    }
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
}> {
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
    return {
      ...summarizeSkillMarkdown(content),
      updatedAt: fileStat.mtimeMs
    }
  } catch {
    return { name: null, description: null, updatedAt: null }
  }
}

async function scanRoot(root: SkillScanRoot): Promise<DiscoveredSkill[]> {
  const maxDepth = root.sourceKind === 'plugin' ? 9 : 4
  const skillFiles = await findSkillFiles(root.path, maxDepth)
  const skills = await Promise.all(
    skillFiles.map(async (skillFilePath) => {
      const directoryPath = dirname(skillFilePath)
      const summary = await readSkillSummary(skillFilePath)
      const sourceKind = sourceKindForSkill(root, skillFilePath)
      return {
        id: stableId(skillFilePath),
        name: summary.name ?? basename(directoryPath),
        description: summary.description,
        providers: root.providers,
        sourceKind,
        sourceLabel: sourceLabelForSkill(root, sourceKind),
        rootPath: root.path,
        directoryPath,
        skillFilePath,
        installed: true,
        fileCount: await countFiles(directoryPath),
        updatedAt: summary.updatedAt
      } satisfies DiscoveredSkill
    })
  )
  return skills
}

function source(
  id: string,
  label: string,
  path: string,
  sourceKind: SkillSourceKind,
  providers: SkillProvider[]
): SkillScanRoot {
  return { id, label, path, sourceKind, providers }
}

export function buildSkillDiscoverySources(
  args: {
    homeDir?: string
    cwd?: string
    repos?: Repo[]
  } = {}
): SkillScanRoot[] {
  const home = args.homeDir ?? homedir()
  const cwd = args.cwd ?? process.cwd()
  const roots: SkillScanRoot[] = [
    source('home-codex', 'Codex home', join(home, '.codex', 'skills'), 'home', ['codex']),
    source('home-agents', 'Agent skills home', join(home, '.agents', 'skills'), 'home', [
      'agent-skills'
    ]),
    source('home-claude', 'Claude home', join(home, '.claude', 'skills'), 'home', ['claude']),
    source(
      'codex-plugin-cache',
      'Codex plugin cache',
      join(home, '.codex', 'plugins', 'cache'),
      'plugin',
      ['codex', 'agent-skills']
    )
  ]

  const repoPaths = new Set<string>()
  for (const repo of args.repos ?? []) {
    if (repo.connectionId) {
      continue
    }
    repoPaths.add(repo.path)
  }
  repoPaths.add(cwd)

  for (const repoPath of repoPaths) {
    const label = `Repo ${basename(repoPath)}`
    roots.push(
      source(
        `repo-agents-${stableId(repoPath)}`,
        `${label} .agents`,
        join(repoPath, '.agents', 'skills'),
        'repo',
        ['agent-skills']
      ),
      source(
        `repo-claude-${stableId(repoPath)}`,
        `${label} .claude`,
        join(repoPath, '.claude', 'skills'),
        'repo',
        ['claude']
      )
    )
  }

  return roots
}

export async function discoverSkills(args: {
  repos?: Repo[]
  homeDir?: string
  cwd?: string
}): Promise<SkillDiscoveryResult> {
  const roots = buildSkillDiscoverySources(args)
  const sources: SkillDiscoverySource[] = []
  const skillGroups = await Promise.all(
    roots.map(async (root) => {
      const exists = await pathExists(root.path)
      sources.push({ ...root, exists, skippedReason: exists ? undefined : 'missing' })
      if (!exists) {
        return []
      }
      return scanRoot(root)
    })
  )
  const seen = new Map<string, DiscoveredSkill>()
  for (const skill of skillGroups.flat()) {
    seen.set(skill.skillFilePath, skill)
  }
  return {
    skills: Array.from(seen.values()).sort(compareSkills),
    sources: sources.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    ),
    scannedAt: Date.now()
  }
}
