import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { HookInstallAgent } from '../../shared/telemetry-events'
import type { GlobalSettings } from '../../shared/types'
import { ampHookService } from '../amp/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { droidHookService } from '../droid/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { devinHookService } from '../devin/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

export type ManagedAgentHookInstaller = readonly [HookInstallAgent, () => void]
type ManagedHookRemover = readonly [HookInstallAgent, () => AgentHookInstallStatus]
type ManagedHookStatusReader = readonly [HookInstallAgent, () => AgentHookInstallStatus]

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
  ['devin', () => devinHookService.install()]
]

const LOCAL_MANAGED_HOOK_REMOVERS: readonly ManagedHookRemover[] = [
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
  ['devin', () => devinHookService.remove()]
]

const LOCAL_MANAGED_HOOK_STATUS_READERS: readonly ManagedHookStatusReader[] = [
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
  ['devin', () => devinHookService.getStatus()]
]

export function isAgentStatusHooksEnabled(
  settings: Pick<GlobalSettings, 'agentStatusHooksEnabled'> | null | undefined
): boolean {
  return settings?.agentStatusHooksEnabled !== false
}

export function installManagedAgentHooks(): void {
  for (const [agent, install] of MANAGED_AGENT_HOOK_INSTALLERS) {
    try {
      install()
    } catch (error) {
      console.warn(`[agent-hooks] Failed to install ${agent} managed hooks:`, error)
    }
  }
}

function errorStatus(agent: HookInstallAgent, error: unknown): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

export function removeManagedAgentHooks(): AgentHookInstallStatus[] {
  return LOCAL_MANAGED_HOOK_REMOVERS.map(([agent, remove]) => {
    try {
      return remove()
    } catch (error) {
      return errorStatus(agent, error)
    }
  })
}

export function getManagedAgentHookStatuses(): AgentHookInstallStatus[] {
  return LOCAL_MANAGED_HOOK_STATUS_READERS.map(([agent, getStatus]) => {
    try {
      return getStatus()
    } catch (error) {
      return errorStatus(agent, error)
    }
  })
}

export function applyAgentStatusHooksEnabled(enabled: boolean): AgentHookInstallStatus[] {
  if (enabled) {
    installManagedAgentHooks()
    return getManagedAgentHookStatuses()
  }
  return removeManagedAgentHooks()
}
