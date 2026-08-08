import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { HookInstallAgent } from '../../shared/telemetry-events'
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
import { openClaudeHookService } from '../openclaude/hook-service'

export type ManagedAgentHookInstaller = readonly [HookInstallAgent, () => AgentHookInstallStatus]
export type ManagedAgentHookRemover = readonly [HookInstallAgent, () => AgentHookInstallStatus]
export type ManagedAgentHookStatusReader = readonly [HookInstallAgent, () => AgentHookInstallStatus]

export const MANAGED_AGENT_HOOK_INSTALLERS: readonly ManagedAgentHookInstaller[] = [
  ['claude', () => claudeHookService.install()],
  ['openclaude', () => openClaudeHookService.install()],
  ['codex', () => codexHookService.install()],
  ['gemini', () => geminiHookService.install()],
  ['antigravity', () => antigravityHookService.install()],
  ['amp', () => ampHookService.install()],
  ['cursor', () => cursorHookService.install()],
  ['droid', () => droidHookService.install()],
  ['command-code', () => commandCodeHookService.install()],
  ['grok', () => grokHookService.install()],
  ['copilot', () => copilotHookService.install()],
  ['hermes', () => hermesHookService.install()],
  ['devin', () => devinHookService.install()],
  ['kimi', () => kimiHookService.install()]
]

export const MANAGED_AGENT_HOOK_REMOVERS: readonly ManagedAgentHookRemover[] = [
  ['claude', () => claudeHookService.remove()],
  ['openclaude', () => openClaudeHookService.remove()],
  ['codex', () => codexHookService.remove()],
  ['gemini', () => geminiHookService.remove()],
  ['antigravity', () => antigravityHookService.remove()],
  ['amp', () => ampHookService.remove()],
  ['cursor', () => cursorHookService.remove()],
  ['droid', () => droidHookService.remove()],
  ['command-code', () => commandCodeHookService.remove()],
  ['grok', () => grokHookService.remove()],
  ['copilot', () => copilotHookService.remove()],
  ['hermes', () => hermesHookService.remove()],
  ['devin', () => devinHookService.remove()],
  ['kimi', () => kimiHookService.remove()]
]

export const MANAGED_AGENT_HOOK_STATUS_READERS: readonly ManagedAgentHookStatusReader[] = [
  ['claude', () => claudeHookService.getStatus()],
  ['openclaude', () => openClaudeHookService.getStatus()],
  ['codex', () => codexHookService.getStatus()],
  ['gemini', () => geminiHookService.getStatus()],
  ['antigravity', () => antigravityHookService.getStatus()],
  ['amp', () => ampHookService.getStatus()],
  ['cursor', () => cursorHookService.getStatus()],
  ['droid', () => droidHookService.getStatus()],
  ['grok', () => grokHookService.getStatus()],
  ['command-code', () => commandCodeHookService.getStatus()],
  ['copilot', () => copilotHookService.getStatus()],
  ['hermes', () => hermesHookService.getStatus()],
  ['devin', () => devinHookService.getStatus()],
  ['kimi', () => kimiHookService.getStatus()]
]
