import { readCodexRolloutSessionMetaId } from '../codex/codex-rollout-session-meta'
import { codexRolloutHardlinkIdentity, dedupeCodexRolloutAliases } from './codex-session-root-dedup'
import { antigravityHistoryPathForBrainDir } from './session-scanner-antigravity-paths'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'
import { DEFAULT_CODEX_HOME_DIR } from './session-scanner-source-discovery'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'

/** Newest-first parse candidates for a discovery set, with Codex hardlink aliases collapsed. */
export async function sessionCandidatesFromDiscoveries(
  discoveries: SessionFileDiscovery[],
  options: AiVaultScanOptions
): Promise<SessionFileCandidate[]> {
  return dedupeCodexRolloutAliases(
    discoveries
      .flatMap((discovery) =>
        discovery.files.map((file): SessionFileCandidate => ({
          agent: discovery.agent,
          file,
          codexHome:
            discovery.agent === 'codex'
              ? codexHomeForSessionsDir(
                  discovery.rootDir,
                  options.defaultCodexHomeDir ?? DEFAULT_CODEX_HOME_DIR
                )
              : null,
          antigravityHistoryPath:
            discovery.agent === 'antigravity'
              ? antigravityHistoryPathForBrainDir(discovery.rootDir)
              : undefined
        }))
      )
      .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs),
    {
      isCodex: (candidate) => candidate.agent === 'codex',
      getFilePath: (candidate) => candidate.file.path,
      getCodexHome: (candidate) => candidate.codexHome,
      getHardlinkIdentity: (candidate) => codexRolloutHardlinkIdentity(candidate.file)
    },
    (filePath) => readCodexRolloutSessionMetaId(filePath, options.signal, 'scan'),
    options.signal
  )
}
