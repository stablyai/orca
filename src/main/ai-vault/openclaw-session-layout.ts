import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'
import { pathSegments } from './session-file-discovery'

/**
 * OpenClaw keeps transcripts at `<state>/agents/<agent id>/sessions/**`. Its siblings,
 * such as `<agent>/agent/codex-home/sessions`, hold other tools' state, so the walk
 * enters only `sessions` below each agent dir (#11394). Depth 0 is an agent dir.
 */
export function openClawSessionDirectoryPredicate(name: string, depth: number): boolean {
  return depth !== 1 || name === 'sessions'
}

const OPENCLAW_STATE_DIR = resolveAbsoluteDirOverride(
  process.env.OPENCLAW_STATE_DIR,
  join(homedir(), '.openclaw')
)

export const OPENCLAW_AGENT_SOURCE: AiVaultAgentSource = {
  // Sessions live under <stateDir>/agents; a stateDir already ending in
  // `agents` is used as-is. The current and legacy state dirs are the same
  // install, so their discoveries merge.
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
