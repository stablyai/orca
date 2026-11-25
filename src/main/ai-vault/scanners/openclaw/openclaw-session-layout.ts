import { homedir } from 'node:os'
import {
  appProfileAgentHomeDir,
  defaultAgentHomeDir
} from '../../../../shared/app-profiles/app-profile-homes'
import { basename, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../../../shared/file-access/absolute-dir-override'
import type { AiVaultAgentSource } from '../../discovery/session-scanner-agent-sources'
import { pathSegments } from '../../discovery/session-file-discovery'

/** At depth 1, enter only agent sessions directories, excluding embedded tools' histories (#11394). */
export function openClawSessionDirectoryPredicate(name: string, depth: number): boolean {
  return depth !== 1 || name === 'sessions'
}

const openClawStateDir = (): string =>
  resolveAbsoluteDirOverride(
    process.env.OPENCLAW_STATE_DIR,
    defaultAgentHomeDir('OPENCLAW_STATE_DIR', '.openclaw')
  )

export const OPENCLAW_AGENT_SOURCE: AiVaultAgentSource = {
  // Current and legacy roots belong to one install; merge their discovered sessions.
  rootDirs: (options, wslHomeDirs) =>
    [
      options.openclawStateDir ?? openClawStateDir(),
      // The legacy folder in the real home belongs to the default app, not to a profile.
      options.openclawLegacyStateDir ??
        (appProfileAgentHomeDir('OPENCLAW_STATE_DIR') ? null : join(homedir(), '.clawdbot')),
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.openclaw')),
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.clawdbot'))
    ]
      .filter((stateDir) => stateDir !== null)
      .map((stateDir) => (basename(stateDir) === 'agents' ? stateDir : join(stateDir, 'agents'))),
  extensions: ['.jsonl'],
  filePredicate: (filePath) => pathSegments(filePath).includes('sessions'),
  directoryPredicate: openClawSessionDirectoryPredicate,
  mergeRootDiscoveries: true
}
