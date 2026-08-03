import { z } from 'zod'

export const ClientUiStatusBarItem = z.enum([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'ssh',
  'resource-usage',
  'orchestration-usage',
  'ports'
])
