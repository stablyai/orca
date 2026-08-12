import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  isAntigravityTranscriptPath,
  shouldDescendAntigravityBrainDirectory
} from './session-scanner-antigravity-paths'
import { discoverFiles } from './session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

const ANTIGRAVITY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain')

export function antigravityDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const rootDirs = [
    options.antigravityBrainDir ?? ANTIGRAVITY_BRAIN_DIR,
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.gemini', 'antigravity-cli', 'brain'))
  ]
  return rootDirs.map((rootDir) =>
    discoverFiles({
      rootDir,
      limit,
      agent: 'antigravity',
      issues,
      extensions: ['.jsonl'],
      filePredicate: isAntigravityTranscriptPath,
      directoryPredicate: shouldDescendAntigravityBrainDirectory
    })
  )
}
