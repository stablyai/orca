import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  AGENT_CONFIG_COMMAND_NAME,
  AGENT_CONFIG_FILE_PATH,
  AGENT_CONFIG_LIMITS,
  AGENT_CONFIG_PROJECT_KINDS,
  AGENT_CONFIG_SELF_PATH,
  AGENT_CONFIG_SKILL_NAME,
  AgentConfigItemKind,
  isSkillKind,
  type AgentConfigItemScope,
  type AgentConfigSkipReason
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { agentConfigDigest, type AgentConfigDigestEntry } from '../agent-config-digest'
import { agentConfigRoot, type AgentConfigHomes } from '../agent-config-roots'
import { hasSecretContent, isSecretFileName } from './agent-config-secret-scan'

export type LocalAgentConfigItem = {
  scope: AgentConfigItemScope
  kind: AgentConfigItemKind
  name: string
  /** Empty when skipped. */
  files: AgentConfigDigestEntry[]
  fileCount: number
  bytes: number
  withheldFiles: number
  digest: string | null
  skipReason?: Extract<AgentConfigSkipReason, 'in-repo' | 'too-large' | 'secret' | 'invalid'>
}

export type LocalAgentConfigReadDeps = {
  homes: AgentConfigHomes
  /** The workspace's checkout on this computer, for project items. */
  repoPath: string | null
  /** Repo-relative paths git tracks under the project agent folders; null when git can't say. */
  trackedPaths: (repoPath: string) => Promise<ReadonlySet<string> | null>
}

/** Folders a skill never needs in the sandbox. */
const SKIPPED_DIRS = new Set(['node_modules', '__pycache__', 'venv'])
const MAX_DEPTH = 8
const SKILL_FILE = 'SKILL.md'

type Walked =
  | { ok: true; files: AgentConfigDigestEntry[]; withheld: number; bytes: number }
  | { ok: false; reason: 'too-large' | 'secret' | 'invalid' }

async function isExecutable(path: string): Promise<boolean> {
  try {
    return ((await stat(path)).mode & 0o111) !== 0
  } catch {
    return false
  }
}

/** One file's verdict: kept, kept back as a likely secret, or too big for any skill. */
async function readItemFile(
  path: string,
  name: string
): Promise<'too-large' | 'withheld' | { bytes: Buffer; executable: boolean }> {
  const info = await stat(path)
  if (info.size > AGENT_CONFIG_LIMITS.fileBytes) {
    return 'too-large'
  }
  if (isSecretFileName(name)) {
    return 'withheld'
  }
  const bytes = await readFile(path)
  if (hasSecretContent(bytes)) {
    return 'withheld'
  }
  return { bytes, executable: await isExecutable(path) }
}

/** Every regular file in a skill folder; symlinks only when they stay inside it. */
async function walkSkill(dir: string): Promise<Walked> {
  const root = await realpath(dir)
  const files: AgentConfigDigestEntry[] = []
  let withheld = 0
  let bytes = 0
  const visit = async (current: string, depth: number): Promise<Walked | null> => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) {
        continue
      }
      const path = join(current, entry.name)
      let resolved = path
      if (entry.isSymbolicLink()) {
        try {
          resolved = await realpath(path)
        } catch {
          continue
        }
        if (resolved !== root && !resolved.startsWith(root + sep)) {
          continue
        }
      }
      const info = await stat(resolved).catch(() => null)
      if (!info) {
        continue
      }
      const rel = relative(dir, path).split(sep).join('/')
      if (info.isDirectory()) {
        if (depth >= MAX_DEPTH) {
          continue
        }
        const nested = await visit(path, depth + 1)
        if (nested) {
          return nested
        }
        continue
      }
      if (!info.isFile()) {
        continue
      }
      if (!AGENT_CONFIG_FILE_PATH.test(rel)) {
        return { ok: false, reason: 'invalid' }
      }
      const read = await readItemFile(resolved, entry.name)
      if (read === 'too-large') {
        return { ok: false, reason: 'too-large' }
      }
      if (read === 'withheld') {
        if (rel === SKILL_FILE) {
          return { ok: false, reason: 'secret' }
        }
        withheld += 1
        continue
      }
      bytes += read.bytes.length
      files.push({ path: rel, executable: read.executable, bytes: read.bytes })
      if (
        files.length > AGENT_CONFIG_LIMITS.filesPerItem ||
        bytes > AGENT_CONFIG_LIMITS.itemBytes
      ) {
        return { ok: false, reason: 'too-large' }
      }
    }
    return null
  }
  const failed = await visit(dir, 0)
  return failed ?? { ok: true, files, withheld, bytes }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isDirectory() === true
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() === true
}

async function readSkills(
  root: string,
  kind: AgentConfigItemKind,
  scope: AgentConfigItemScope
): Promise<LocalAgentConfigItem[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const items: LocalAgentConfigItem[] = []
  for (const entry of entries) {
    const dir = join(root, entry.name)
    // Hidden folders hold tool state (Codex's .system skills, trash), not the user's skills.
    if (entry.name.startsWith('.') || !(await isDirectory(dir))) {
      continue
    }
    if (!(await isFile(join(dir, SKILL_FILE)))) {
      continue
    }
    const base = { scope, kind, name: entry.name, withheldFiles: 0 }
    if (!AGENT_CONFIG_SKILL_NAME.test(entry.name)) {
      items.push({
        ...base,
        files: [],
        fileCount: 0,
        bytes: 0,
        digest: null,
        skipReason: 'invalid'
      })
      continue
    }
    const walked = await walkSkill(dir).catch((): Walked => ({ ok: false, reason: 'invalid' }))
    if (!walked.ok) {
      items.push({
        ...base,
        files: [],
        fileCount: 0,
        bytes: 0,
        digest: null,
        skipReason: walked.reason
      })
      continue
    }
    items.push({
      ...base,
      files: walked.files,
      fileCount: walked.files.length,
      bytes: walked.bytes,
      withheldFiles: walked.withheld,
      digest: agentConfigDigest(walked.files)
    })
  }
  return items
}

/** Markdown commands, namespaced by folder (Claude) or flat (Codex prompts). */
async function readCommands(
  root: string,
  kind: AgentConfigItemKind,
  scope: AgentConfigItemScope
): Promise<LocalAgentConfigItem[]> {
  const maxDepth = kind === 'codex-prompt' ? 0 : 2
  const items: LocalAgentConfigItem[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }
      const path = join(dir, entry.name)
      const info = await stat(path).catch(() => null)
      if (info?.isDirectory()) {
        if (depth < maxDepth) {
          await visit(path, depth + 1)
        }
        continue
      }
      if (!info?.isFile() || !entry.name.endsWith('.md')) {
        continue
      }
      const name = relative(root, path).split(sep).join('/').slice(0, -'.md'.length)
      const base = { scope, kind, name, withheldFiles: 0, fileCount: 1 }
      const skipped = (
        skipReason: NonNullable<LocalAgentConfigItem['skipReason']>
      ): LocalAgentConfigItem => ({
        ...base,
        files: [],
        bytes: info.size,
        digest: null,
        skipReason
      })
      if (!AGENT_CONFIG_COMMAND_NAME.test(name)) {
        items.push(skipped('invalid'))
        continue
      }
      const read = await readItemFile(path, entry.name).catch(() => 'invalid' as const)
      if (read === 'too-large' || read === 'invalid') {
        items.push(skipped(read))
        continue
      }
      if (read === 'withheld') {
        items.push(skipped('secret'))
        continue
      }
      const files = [
        { path: AGENT_CONFIG_SELF_PATH, executable: false, bytes: read.bytes } // commands are never run
      ]
      items.push({ ...base, files, bytes: read.bytes.length, digest: agentConfigDigest(files) })
    }
  }
  await visit(root, 0)
  return items
}

/** Repo-relative path of an item, as `git ls-files` prints it. */
function repoRelative(repoPath: string, root: string, kind: AgentConfigItemKind, name: string) {
  const rel = relative(repoPath, root).split(sep).join('/')
  return isSkillKind(kind) ? `${rel}/${name}/` : `${rel}/${name}.md`
}

/** This computer's Claude Code and Codex skills and commands, user scope and the workspace's project. */
export async function readLocalAgentConfig(
  deps: LocalAgentConfigReadDeps
): Promise<LocalAgentConfigItem[]> {
  const items: LocalAgentConfigItem[] = []
  for (const kind of AgentConfigItemKind.options) {
    const root = agentConfigRoot(kind, 'user', deps.homes, null)
    if (root) {
      items.push(...(await (isSkillKind(kind) ? readSkills : readCommands)(root, kind, 'user')))
    }
  }
  const repoPath = deps.repoPath
  if (repoPath) {
    const tracked = await deps.trackedPaths(repoPath).catch(() => null)
    for (const kind of AgentConfigItemKind.options) {
      const root = AGENT_CONFIG_PROJECT_KINDS.has(kind)
        ? agentConfigRoot(kind, 'project', deps.homes, repoPath)
        : null
      // A project folder that is a link elsewhere is not the repo's; leave it alone.
      if (!root || (await lstat(root).catch(() => null))?.isSymbolicLink()) {
        continue
      }
      for (const item of await (isSkillKind(kind) ? readSkills : readCommands)(
        root,
        kind,
        'project'
      )) {
        const path = repoRelative(repoPath, root, kind, item.name)
        // Committed items reach the sandbox with the clone; unknown means assume committed.
        const inRepo =
          tracked === null ||
          [...tracked].some((file) => (isSkillKind(kind) ? file.startsWith(path) : file === path))
        items.push(
          inRepo && !item.skipReason
            ? { ...item, files: [], digest: null, skipReason: 'in-repo' }
            : item
        )
      }
    }
  }
  return items
}
