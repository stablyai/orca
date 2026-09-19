import { ampHookService } from '../amp/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { devinHookService } from '../devin/hook-service'
import { droidHookService } from '../droid/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { mastraCodeHookService } from '../mastracode/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

export const REMOTE_MANAGED_HOOK_SERVICES_BY_AGENT = new Map<string, { installRemote?: unknown }>([
  ['claude', claudeHookService],
  ['openclaude', openClaudeHookService],
  ['codex', codexHookService],
  ['gemini', geminiHookService],
  ['antigravity', antigravityHookService],
  ['amp', ampHookService],
  ['cursor', cursorHookService],
  ['droid', droidHookService],
  ['command-code', commandCodeHookService],
  ['grok', grokHookService],
  ['copilot', copilotHookService],
  ['hermes', hermesHookService],
  ['devin', devinHookService],
  ['kimi', kimiHookService],
  ['mastracode', mastraCodeHookService]
])
