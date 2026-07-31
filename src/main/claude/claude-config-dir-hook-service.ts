import { isClaudeFlavorConfigDirName } from './claude-config-dir-discovery'
import { ClaudeHookService } from './hook-service'

export function createClaudeConfigDirHookService(configDirName: string): ClaudeHookService {
  if (!isClaudeFlavorConfigDirName(configDirName)) {
    throw new Error('Invalid Claude config-dir name')
  }
  return new ClaudeHookService({
    agent: 'claude',
    displayName: 'Claude',
    settings: { configDirName, scriptBaseName: 'claude-hook' }
  })
}
