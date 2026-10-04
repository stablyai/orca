import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import { sessionRootDirs } from './session-scanner-roots'
import { selectDshGenerationEntries } from './session-scanner-dsh-generations'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'

export const DSH_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) =>
    sessionRootDirs(
      options.dshSessionsDir ??
        join(resolveAbsoluteDirOverride(process.env.DSH_HOME, join(homedir(), '.dsh')), 'sessions'),
      wslHomeDirs,
      ['.dsh', 'sessions']
    ),
  extensions: ['.jsonl', '.zstd'],
  selectDirectoryEntries: selectDshGenerationEntries,
  directoryPredicate: (_name, depth) => depth < 2
}
