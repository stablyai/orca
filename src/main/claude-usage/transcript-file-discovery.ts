import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), '.claude', 'transcripts')

type ClaudeTranscriptDiscoveryOptions = {
  platform?: NodeJS.Platform
  configDir?: string
  includeWslHomes?: boolean
  listWslHomeDirs?: () => Promise<string[]>
}

function joinConfigPath(configDir: string, child: string): string {
  return isWslUncPath(configDir) ? win32.join(configDir, child) : join(configDir, child)
}

async function walkJsonlFiles(dirPath: string): Promise<string[]> {
  const entries = isWslUncPath(dirPath)
    ? await wslGatedReaddir(dirPath, 'scan')
    : await readdir(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = isWslUncPath(dirPath)
      ? win32.join(dirPath, entry.name)
      : join(dirPath, entry.name)
    if (entry.isDirectory()) {
      appendDiscoveredFiles(files, await walkJsonlFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }

  return files
}

function appendDiscoveredFiles(target: string[], source: readonly string[]): void {
  // Why: long-lived transcript directories can exceed V8's argument limit if child file arrays are spread into push().
  for (const filePath of source) {
    target.push(filePath)
  }
}

async function defaultListWslHomeDirs(): Promise<string[]> {
  const homes = await Promise.allSettled(
    (await listWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes
    .filter(
      (result): result is PromiseFulfilledResult<string | null> => result.status === 'fulfilled'
    )
    .map((result) => result.value)
    .filter((home): home is string => Boolean(home))
}

export async function listClaudeTranscriptFiles(
  options: ClaudeTranscriptDiscoveryOptions = {}
): Promise<string[]> {
  const roots = options.configDir
    ? [
        joinConfigPath(options.configDir, 'projects'),
        joinConfigPath(options.configDir, 'transcripts')
      ]
    : [CLAUDE_PROJECTS_DIR, CLAUDE_TRANSCRIPTS_DIR]
  if (
    options.includeWslHomes ||
    (!options.configDir && (options.platform ?? process.platform) === 'win32')
  ) {
    const wslHomeDirs = await (options.listWslHomeDirs ?? defaultListWslHomeDirs)().catch(() => [])
    for (const homeDir of wslHomeDirs) {
      roots.push(win32.join(homeDir, '.claude', 'projects'))
      roots.push(win32.join(homeDir, '.claude', 'transcripts'))
    }
  }
  const files = await Promise.all(
    roots.map(async (root) => {
      try {
        return await walkJsonlFiles(root)
      } catch {
        return []
      }
    })
  )
  return [...new Set(files.flat())].sort()
}
