import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'
import { pathSegments } from './session-file-discovery'

/** At depth 1, enter only agent sessions directories, excluding embedded tools' histories (#11394). */
export function openClawSessionDirectoryPredicate(name: string, depth: number): boolean {
  return depth !== 1 || name === 'sessions'
}

const OPENCLAW_STATE_DIR = resolveAbsoluteDirOverride(
  process.env.OPENCLAW_STATE_DIR,
  join(homedir(), '.openclaw')
)

export const OPENCLAW_AGENT_SOURCE: AiVaultAgentSource = {
  // Current and legacy roots belong to one install; merge their discovered sessions.
  rootDirs: (options, wslHomeDirs) =>
    [
      options.openclawStateDir ?? OPENCLAW_STATE_DIR,
      options.openclawLegacyStateDir ?? join(homedir(), '.clawdbot'),
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.openclaw')),
      ...wslHomeDirs.map((homeDir) => join(homeDir, '.clawdbot'))
    ].map((stateDir) => (basename(stateDir) === 'agents' ? stateDir : join(stateDir, 'agents'))),
  extensions: ['.jsonl'],
  filePredicate: (filePath) => pathSegments(filePath).includes('sessions'),
  directoryPredicate: openClawSessionDirectoryPredicate,
  mergeRootDiscoveries: true
}
