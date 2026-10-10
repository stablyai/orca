import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveKiroHomeDir } from '../../shared/kiro-home'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'
import {
  isKiroSessionMetadataPath,
  kiroTranscriptPathForMetadata
} from './session-scanner-kiro-parser'
import {
  isKiroV3SessionManifestPath,
  kiroV3SessionDirectoryPredicate,
  kiroV3TranscriptPathForManifest
} from './session-scanner-kiro-v3-parser'
import { sessionRootDirs } from './session-scanner-roots'

const KIRO_SESSIONS_DIR = join(resolveKiroHomeDir(), 'sessions', 'cli')
// Why not $KIRO_HOME: the V3 engine ignores it (kiro-cli 2.27.1) and always writes ~/.kiro/sessions.
const KIRO_V3_SESSIONS_DIR = join(homedir(), '.kiro', 'sessions')

/**
 * Kiro's `kiro-cli chat` store (flat `cli/<uuid>.json`) plus the opt-in V3 engine's
 * `<workspace-hash>/sess_<uuid>/session.json`; both list as `kiro` rows.
 */
export const KIRO_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) => [
    ...sessionRootDirs(options.kiroSessionsDir ?? KIRO_SESSIONS_DIR, wslHomeDirs, [
      '.kiro',
      'sessions',
      'cli'
    ]),
    ...sessionRootDirs(options.kiroV3SessionsDir ?? KIRO_V3_SESSIONS_DIR, wslHomeDirs, [
      '.kiro',
      'sessions'
    ])
  ],
  extensions: ['.json'],
  filePredicate: (filePath) =>
    isKiroSessionMetadataPath(filePath) || isKiroV3SessionManifestPath(filePath),
  // Why: turns append to the transcript beside the metadata; its stat must refresh the cached row.
  contentDependencyPath: (filePath) =>
    isKiroV3SessionManifestPath(filePath)
      ? kiroV3TranscriptPathForManifest(filePath)
      : kiroTranscriptPathForMetadata(filePath),
  // One predicate serves both roots: the `cli/` root has only task-state UUID dirs to skip,
  // and the V3 root must not descend into `cli/` and list its sessions twice.
  directoryPredicate: kiroV3SessionDirectoryPredicate
}
