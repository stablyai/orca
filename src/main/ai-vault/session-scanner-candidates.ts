import { prioritizeAntigravityTranscriptCandidates } from './antigravity-transcript-candidates'
import { readCodexRolloutSessionMetaId } from '../codex/codex-rollout-session-meta'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutAliases,
  dedupeCodexRolloutFileAliases
} from './codex-session-root-dedup'
import { antigravityHistoryPathForBrainDir } from './session-scanner-antigravity-paths'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'
import { DEFAULT_CODEX_HOME_DIR } from './session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'

/** One discovery's files as parse candidates, attributed to their Codex home. */
export function discoveryFileCandidates(
  discovery: SessionFileDiscovery,
  files: readonly FileWithMtime[],
  options: AiVaultScanOptions
): SessionFileCandidate[] {
  const codexHome =
    discovery.agent === 'codex'
      ? codexHomeForSessionsDir(
          discovery.rootDir,
          options.defaultCodexHomeDir ?? DEFAULT_CODEX_HOME_DIR
        )
      : null
  const antigravityHistoryPath =
    discovery.agent === 'antigravity'
      ? antigravityHistoryPathForBrainDir(discovery.rootDir)
      : undefined
  return files.map((file) => ({
    agent: discovery.agent,
    file,
    codexHome,
    antigravityHistoryPath
  }))
}

const CODEX_ALIAS_ACCESSORS = {
  isCodex: (candidate: SessionFileCandidate) => candidate.agent === 'codex',
  getFilePath: (candidate: SessionFileCandidate) => candidate.file.path,
  getCodexHome: (candidate: SessionFileCandidate) => candidate.codexHome,
  getHardlinkIdentity: (candidate: SessionFileCandidate) =>
    codexRolloutHardlinkIdentity(candidate.file)
}

/** Keeps one rollout per hardlink, in its preferred Codex home; reads no files. */
export function dropCodexHardlinkAliases(
  candidates: readonly SessionFileCandidate[]
): SessionFileCandidate[] {
  return dedupeCodexRolloutFileAliases(candidates, CODEX_ALIAS_ACCESSORS)
}

/** Newest-first parse candidates for a discovery set, with Codex hardlink aliases collapsed. */
export async function sessionCandidatesFromDiscoveries(
  discoveries: SessionFileDiscovery[],
  options: AiVaultScanOptions
): Promise<SessionFileCandidate[]> {
  const candidates = await dedupeCodexRolloutAliases(
    discoveries
      .flatMap((discovery) => discoveryFileCandidates(discovery, discovery.files, options))
      .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs),
    CODEX_ALIAS_ACCESSORS,
    (filePath) => readCodexRolloutSessionMetaId(filePath, options.signal, 'scan'),
    options.signal
  )
  return prioritizeAntigravityTranscriptCandidates(
    candidates,
    (candidate) => candidate.agent === 'antigravity'
  )
}
