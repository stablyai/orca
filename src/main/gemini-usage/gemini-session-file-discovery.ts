import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { normalizeFsPath } from '../usage/usage-path-comparison'

const YIELD_EVERY_DISCOVERY_ENTRIES = 100

export async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    return normalizeFsPath(await realpath(pathValue))
  } catch {
    return normalizeFsPath(pathValue)
  }
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function walkSessionFiles(
  dirPath: string,
  progress: { entriesVisited: number } = { entriesVisited: 0 }
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []

  for (const entry of entries) {
    progress.entriesVisited += 1
    if (progress.entriesVisited % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (
        entry.name === 'chunks' ||
        entry.name === '.user_uploaded' ||
        entry.name === 'scratch' ||
        entry.name === 'mcp' ||
        entry.name === 'builtin' ||
        entry.name === 'plugins' ||
        entry.name === 'updater' ||
        entry.name === 'presence' ||
        entry.name === 'implicit' ||
        entry.name === 'bin'
      ) {
        continue
      }
      appendDiscoveredFiles(files, await walkSessionFiles(fullPath, progress))
      continue
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json')) &&
      !entry.name.startsWith('.') &&
      entry.name !== 'history.jsonl' &&
      entry.name !== 'transcript_full.jsonl'
    ) {
      files.push(fullPath)
    }
  }

  return files
}

function appendDiscoveredFiles(target: string[], source: readonly string[]): void {
  for (const filePath of source) {
    target.push(filePath)
  }
}

export function getGeminiSessionsDirectory(): string {
  if (process.env.GEMINI_SESSIONS_DIR?.trim()) {
    return process.env.GEMINI_SESSIONS_DIR.trim()
  }
  const home = process.env.GEMINI_HOME?.trim() || homedir()
  return join(home, '.gemini', 'tmp')
}

export function getAntigravityBrainDirectory(): string {
  if (process.env.ANTIGRAVITY_BRAIN_DIR?.trim()) {
    return process.env.ANTIGRAVITY_BRAIN_DIR.trim()
  }
  const home = process.env.GEMINI_HOME?.trim() || homedir()
  return join(home, '.gemini', 'antigravity-cli', 'brain')
}

export function getGeminiSessionDirectories(): string[] {
  const dirs = [getGeminiSessionsDirectory(), getAntigravityBrainDirectory()]
  return dirs.filter((dirPath, index, allDirPaths) => allDirPaths.indexOf(dirPath) === index)
}

export function extractSessionIdFromPath(filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter(Boolean)
  const lastIndex = segments.length - 1
  if (
    segments[lastIndex] === 'transcript.jsonl' ||
    segments[lastIndex] === 'transcript_full.jsonl'
  ) {
    if (
      segments[lastIndex - 1] === 'logs' &&
      segments[lastIndex - 2] === '.system_generated' &&
      segments[lastIndex - 3]
    ) {
      return segments[lastIndex - 3]
    }
  }
  const isJson = filePath.endsWith('.json')
  return basename(filePath, isJson ? '.json' : '.jsonl')
}

export async function loadAntigravityHistory(
  brainOrFilePath: string
): Promise<Map<string, string>> {
  const historyMap = new Map<string, string>()
  const configuredBrainDir = getAntigravityBrainDirectory()
  const possiblePaths = [
    join(dirname(configuredBrainDir), 'history.jsonl'),
    join(configuredBrainDir, 'history.jsonl'),
    join(dirname(brainOrFilePath), 'history.jsonl'),
    join(dirname(dirname(brainOrFilePath)), 'history.jsonl')
  ]
  const seenPaths = new Set<string>()
  for (const histPath of possiblePaths) {
    if (seenPaths.has(histPath) || !existsSync(histPath)) {
      continue
    }
    seenPaths.add(histPath)
    try {
      const content = await readFile(histPath, 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) {
          continue
        }
        try {
          const entry = JSON.parse(line) as { conversationId?: string; workspace?: string }
          if (entry.conversationId && entry.workspace) {
            historyMap.set(entry.conversationId, entry.workspace)
          }
        } catch {}
      }
    } catch {}
  }
  return historyMap
}

async function getPhysicalFileAliasKey(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath)
    if (fileStat.ino !== 0) {
      return `${fileStat.dev}:${fileStat.ino}`
    }
  } catch {}
  return `path:${await canonicalizePath(filePath)}`
}

async function dedupeGeminiSessionFileAliases(files: string[]): Promise<string[]> {
  const seenAliases = new Set<string>()
  const uniqueFiles: string[] = []
  for (const [index, filePath] of [...new Set(files)].sort().entries()) {
    const aliasKey = await getPhysicalFileAliasKey(filePath)
    if (seenAliases.has(aliasKey)) {
      continue
    }
    seenAliases.add(aliasKey)
    uniqueFiles.push(filePath)
    if ((index + 1) % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
  }
  return uniqueFiles
}

export async function listGeminiSessionFiles(): Promise<string[]> {
  const files: string[] = []
  for (const dirPath of getGeminiSessionDirectories()) {
    if (!existsSync(dirPath)) {
      continue
    }
    try {
      appendDiscoveredFiles(files, await walkSessionFiles(dirPath))
    } catch {
      // Missing or unreadable directory should not throw.
    }
  }
  return dedupeGeminiSessionFileAliases(files)
}
