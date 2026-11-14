import { join } from 'node:path'
import { anteTranscriptPathForMetadata } from '../../../../shared/ai-vault/session-display/ai-vault-session-log-resource'
import { isAnteSessionMetadataPath, resolveAnteSessionsDir } from './session-scanner-ante-paths'
import type { AiVaultAgentSource } from '../../discovery/session-scanner-agent-sources'

/** Keep the Ante source entry out of the shared table: that file sits at the lint line budget. */
export const ANTE_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) => [
    resolveAnteSessionsDir(options.anteSessionsDir),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.ante', 'sessions'))
  ],
  extensions: ['.json'],
  // Only session folders carry meta.json; subagent transcripts have none and stay folded in.
  filePredicate: isAnteSessionMetadataPath,
  contentDependencyPath: anteTranscriptPathForMetadata
}
