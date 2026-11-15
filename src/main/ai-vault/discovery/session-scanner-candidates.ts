import { prioritizeAntigravityTranscriptCandidates } from '../scanners/antigravity/antigravity-transcript-candidates'
import { readCodexRolloutSessionMetaId } from '../../codex/history/rollouts/codex-rollout-session-meta'
import {
  codexRolloutHardlinkIdentity,
  canonicalCodexRolloutKey,
  codexSessionRootRank,
  dedupeCodexRolloutCopyAliases,
  dedupeCodexRolloutFileAliases
} from '../scanners/codex/codex-session-root-dedup'
import { antigravityHistoryPathForBrainDir } from '../scanners/antigravity/session-scanner-antigravity-paths'
import { codexHomeForSessionsDir } from '../scanners/codex/session-scanner-codex-paths'
import { DEFAULT_CODEX_HOME_DIR } from './session-scanner-agent-sources'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileCandidate,
  SessionFileChoice,
  SessionFileDiscovery
} from '../session-scanner-types'

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

// OMP inherits PI_CODING_AGENT_DIR; the Pi parse labels the OMP transcripts it reads, so read each once.
function dropOmpCandidatesListedByPi(
  candidates: readonly SessionFileCandidate[]
): SessionFileCandidate[] {
  const piPaths = new Set(
    candidates.flatMap((candidate) => (candidate.agent === 'pi' ? [candidate.file.path] : []))
  )
  return candidates.filter(
    (candidate) => candidate.agent !== 'omp' || !piPaths.has(candidate.file.path)
  )
}

export async function sessionCandidatesFromDiscoveries(
  discoveries: SessionFileDiscovery[],
  options: AiVaultScanOptions
): Promise<SessionFileChoice[]> {
  const physical = dropCodexHardlinkAliases(
    dropOmpCandidatesListedByPi(
      discoveries.flatMap((discovery) =>
        discoveryFileCandidates(discovery, discovery.files, options)
      )
    ).sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
  )
  const canonical = new Map<string, SessionFileCandidate[]>()
  const legacy: SessionFileCandidate[] = []
  for (const candidate of physical) {
    const key = candidate.agent === 'codex' ? canonicalCodexRolloutKey(candidate.file.path) : null
    if (key === null) {
      legacy.push(candidate)
    } else {
      const group = canonical.get(key)
      if (group) {
        group.push(candidate)
      } else {
        canonical.set(key, [candidate])
      }
    }
  }
  const candidates: SessionFileChoice[] = await dedupeCodexRolloutCopyAliases(
    legacy,
    CODEX_ALIAS_ACCESSORS,
    (filePath) => readCodexRolloutSessionMetaId(filePath, options.signal, 'scan'),
    options.signal
  )
  for (const group of canonical.values()) {
    group.sort(
      (a, b) =>
        Number(a.file.sizeBytes === 0) - Number(b.file.sizeBytes === 0) ||
        codexSessionRootRank(a.codexHome) - codexSessionRootRank(b.codexHome) ||
        Number(a.file.path.endsWith('.zst')) - Number(b.file.path.endsWith('.zst')) ||
        (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0)
    )
    candidates.push(group.length === 1 ? group[0] : { ...group[0], alternatives: group })
  }
  candidates.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs)
  return prioritizeAntigravityTranscriptCandidates(
    candidates,
    (candidate) => candidate.agent === 'antigravity'
  )
}
