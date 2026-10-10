import { claudeProfileHistoryDirs } from '../claude-accounts/claude-profile-installed-router'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), '.claude', 'transcripts')

async function walkJsonlFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
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
  // Why: long-lived transcript directories can exceed V8's argument limit if
  // child file arrays are spread into push().
  for (const filePath of source) {
    target.push(filePath)
  }
}

/** Resolved by the host process: a scan worker has no account router of its own. */
export function claudeProfileTranscriptDirs(): string[] {
  return [...claudeProfileHistoryDirs('projects'), ...claudeProfileHistoryDirs('transcripts')]
}

export async function listClaudeTranscriptFiles(
  profileDirs = claudeProfileTranscriptDirs()
): Promise<string[]> {
  const roots = [CLAUDE_PROJECTS_DIR, CLAUDE_TRANSCRIPTS_DIR, ...profileDirs]
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
