import { basename, join } from 'node:path'
import type { AiVaultAgentSource } from '../ai-vault/session-scanner-agent-sources'
import { traexPrivateHome } from './traex-launch-resolution'

export const TRAEX_AI_VAULT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) => [
    options.traeSessionsDir ?? join(traexPrivateHome(process.env), 'sessions'),
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.trae', 'cli', 'sessions'))
  ],
  extensions: ['.jsonl'],
  filePredicate: (filePath) => basename(filePath).startsWith('rollout-')
}
