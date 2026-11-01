import {
  claudeProfileHistoryDirs,
  claudeAccountHistoryRoots
} from '../claude-accounts/claude-profile-installed-router'
import { isDirectory } from '../claude-accounts/claude-profile-homes'
import type { UsageAccountRoot } from '../usage/usage-account-attribution'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), '.claude', 'transcripts')

async function walkJsonlFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isDefinitiveAbsence(error)) {
      return []
    }
    throw error
  })
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
  // Spreading large transcript directories into push() can exceed V8's argument limit.
  for (const filePath of source) {
    target.push(filePath)
  }
}

/** Resolved by the host process: a scan worker has no account router of its own. */
export function claudeProfileTranscriptDirs(): string[] {
  return [...claudeProfileHistoryDirs('projects'), ...claudeProfileHistoryDirs('transcripts')]
}

export function claudeProfileTranscriptSources(): UsageAccountRoot[] {
  return claudeAccountHistoryRoots().flatMap((root) =>
    ['projects', 'transcripts'].flatMap((surface) => {
      const path = join(root.path, surface)
      return isDirectory(path) ? [{ path, accountId: root.accountId }] : []
    })
  )
}

export async function listClaudeTranscriptFiles(
  profileDirs = claudeProfileTranscriptDirs()
): Promise<string[]> {
  const roots = new Set([CLAUDE_PROJECTS_DIR, CLAUDE_TRANSCRIPTS_DIR, ...profileDirs])
  const files = await Promise.all([...roots].map((root) => walkJsonlFiles(root)))
  return [...new Set(files.flat())].sort()
}
