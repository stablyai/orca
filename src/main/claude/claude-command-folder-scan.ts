import type { Dirent } from 'node:fs'
import { opendir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'

const MARKDOWN_EXTENSION = '.md'
const MAX_SCAN_DEPTH = 24
const MAX_SCAN_ENTRIES = 1_000
const MAX_COMMAND_FILE_BYTES = 256 * 1024

type ScanBudget = { remainingEntries: number; signal?: AbortSignal }

async function readEntries(path: string, budget: ScanBudget): Promise<Dirent[]> {
  try {
    const entries: Dirent[] = []
    budget.signal?.throwIfAborted()
    const directory = await opendir(path)
    if (budget.signal?.aborted) {
      await directory.close()
      budget.signal.throwIfAborted()
    }
    for await (const entry of directory) {
      budget.signal?.throwIfAborted()
      if (budget.remainingEntries === 0) {
        break
      }
      budget.remainingEntries -= 1
      entries.push(entry)
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    budget.signal?.throwIfAborted()
    return []
  }
}

async function walkMarkdown(
  path: string,
  depth: number,
  budget: ScanBudget,
  found: string[]
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH || budget.remainingEntries === 0) {
    return
  }
  for (const entry of await readEntries(path, budget)) {
    budget.signal?.throwIfAborted()
    // Do not follow links outside the command tree.
    if (entry.isSymbolicLink()) {
      continue
    }
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      await walkMarkdown(entryPath, depth + 1, budget, found)
    } else if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)) {
      found.push(entryPath)
    }
  }
}

async function describe(filePath: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const markdown = await readFile(filePath, { encoding: 'utf8', signal })
    return (
      summarizeSkillMarkdown(markdown.slice(0, MAX_COMMAND_FILE_BYTES)).description ?? undefined
    )
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

/** Map nested paths to colon-separated commands; earlier roots win name collisions. */
export async function scanClaudeCommandFolders(
  roots: readonly string[],
  signal?: AbortSignal
): Promise<AgentSessionSlashCommand[]> {
  const budget = { remainingEntries: MAX_SCAN_ENTRIES, signal }
  const commands = new Map<string, AgentSessionSlashCommand>()
  for (const root of roots) {
    const files: string[] = []
    signal?.throwIfAborted()
    await walkMarkdown(root, 0, budget, files)
    for (const file of files) {
      const name = relative(root, file).slice(0, -MARKDOWN_EXTENSION.length).split(sep).join(':')
      if (commands.has(name)) {
        continue
      }
      signal?.throwIfAborted()
      const description = await describe(file, signal)
      commands.set(name, { name, kind: 'command', ...(description ? { description } : {}) })
    }
  }
  return [...commands.values()]
}
