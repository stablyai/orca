import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AiVaultAgentSource } from '../../session-scanner-agent-sources'
import { pathSegments } from '../../session-file-discovery'
import { SUBAGENT_DIR_NAME } from '../claude/session-scanner-subagent-transcripts'

const ZEROCLAW_STATE_DIR =
  process.env.ZEROCLAW_STATE_DIR?.trim() ||
  process.env.ZEROCLAW_HOME?.trim() ||
  join(homedir(), '.zeroclaw')

export const ZEROCLAW_AGENT_SOURCE: AiVaultAgentSource = {
  // Sessions live under <stateDir>/sessions or <stateDir>/agents/.../sessions.
  rootDirs: (options, wslHomeDirs) => [
    options.zeroclawStateDir ?? ZEROCLAW_STATE_DIR,
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.zeroclaw'))
  ],
  extensions: ['.jsonl', '.json'],
  filePredicate: (filePath) => pathSegments(filePath).includes('sessions'),
  directoryPredicate: (name) => name !== SUBAGENT_DIR_NAME,
  mergeRootDiscoveries: true
}
