import { completeAntigravityTranscriptPairs } from './antigravity-transcript-candidates'
import { recordAntigravityArtifactPath } from './antigravity-session-artifacts'
import { ANTIGRAVITY_HISTORY_ROOTS } from '../../../../shared/antigravity-session-origin'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  isAntigravityTranscriptPath,
  shouldDescendAntigravityBrainDirectory
} from './session-scanner-antigravity-paths'
import { discoverFiles } from '../../session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from '../../session-scanner-types'
import { scopeWalksAgentFiles } from '../../session-scope-cwd'

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
    // Unowned rows resume only as references, which clients without the opt-in would launch as agy IDs.
    ...(options.includeAntigravityIdeSessions === true && options.antigravityChatBrainDir
      ? [options.antigravityChatBrainDir]
      : []),
    ...wslHomeDirs.flatMap((homeDir) =>
      origins.map((origin) => join(homeDir, '.gemini', origin, 'brain'))
    )
  ]
  return rootDirs.map((rootDir) => {
    const antigravityArtifactPaths = new Map<string, string>()
    return discoverFiles({
      rootDir,
      limit,
      agent: 'antigravity',
      issues,
      extensions: ['.jsonl'],
      filePredicate: isAntigravityTranscriptPath,
      directoryPredicate: shouldDescendAntigravityBrainDirectory,
      onDirectoryEntries: (dirPath, entries) =>
        recordAntigravityArtifactPath(antigravityArtifactPaths, rootDir, dirPath, entries),
      keepScopeFiles: scopeWalksAgentFiles('antigravity', options.scopePaths),
      signal: options.signal
    })
      .then((discovery) => completeAntigravityTranscriptPairs(discovery, issues))
      .then((discovery) => ({ ...discovery, antigravityArtifactPaths }))
  })
}
