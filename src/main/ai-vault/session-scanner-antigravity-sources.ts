import { completeAntigravityTranscriptPairs } from './antigravity-transcript-candidates'
import { ANTIGRAVITY_HISTORY_ROOTS } from '../../shared/antigravity-session-origin'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  isAntigravityTranscriptPath,
  shouldDescendAntigravityBrainDirectory
} from './session-scanner-antigravity-paths'
import { discoverFiles } from './session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

export function antigravityDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const origins =
    options.includeAntigravityIdeSessions === true
      ? ANTIGRAVITY_HISTORY_ROOTS
      : (['antigravity-cli'] as const)
  const home = options.antigravityAppHome ?? homedir()
  const rootDirs = [
    options.antigravityBrainDir ?? join(home, '.gemini', 'antigravity-cli', 'brain'),
    ...(options.includeAntigravityIdeSessions === true &&
    (!options.antigravityBrainDir || options.antigravityAppHome)
      ? origins
          .filter((origin) => origin !== 'antigravity-cli')
          .map((origin) => join(home, '.gemini', origin, 'brain'))
      : []),
    ...wslHomeDirs.flatMap((homeDir) =>
      origins.map((origin) => join(homeDir, '.gemini', origin, 'brain'))
    )
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
    }).then((discovery) => completeAntigravityTranscriptPairs(discovery, issues))
  )
}
