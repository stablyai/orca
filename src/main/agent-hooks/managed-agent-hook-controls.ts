import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { HookInstallAgent } from '../../shared/telemetry-events'
import type { ClaudeManagedAccount, GlobalSettings } from '../../shared/types'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { ampHookService } from '../amp/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { claudeHookService, type ClaudeLocalHookTarget } from '../claude/hook-service'
import { CLAUDE_HOOK_SETTINGS, getConfigPath } from '../claude/hook-settings'
import { codexHookService } from '../codex/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { droidHookService } from '../droid/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { devinHookService } from '../devin/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

export type ManagedAgentHookInstaller = readonly [HookInstallAgent, () => void]
type ManagedHookRemover = readonly [
  HookInstallAgent,
  (settings?: ManagedHookSettings) => AgentHookInstallStatus | AgentHookInstallStatus[]
]
type ManagedHookStatusReader = readonly [HookInstallAgent, () => AgentHookInstallStatus]
type ManagedHookSettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentStatusHooksEnabled'
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountIdsByRuntime'
    | 'localAccountRuntime'
    | 'localAccountWslDistro'
  >
>
type ManagedHookRemovalOptions = {
  includeWslSystemDefaultDiscovery?: boolean
}
type WslSystemDefaultHookTargetResolver = {
  getDefaultWslDistro(): string | null
  getWslHome(distro: string): string | null
}

const recordedClaudeWslSystemDefaultHookTargets: ClaudeLocalHookTarget[] = []
let wslSystemDefaultHookTargetResolver: WslSystemDefaultHookTargetResolver | null = null

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

const LOCAL_MANAGED_HOOK_REMOVERS: readonly ManagedHookRemover[] = [
  ['claude', (settings) => removeClaudeHooksFromKnownConfigDirs(settings)],
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

function getClaudeHookRemovalTargets(
  settings: ManagedHookSettings | undefined,
  options: ManagedHookRemovalOptions = {}
): ClaudeLocalHookTarget[] {
  const targets: ClaudeLocalHookTarget[] = [{}]
  const ambientConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (ambientConfigDir) {
    targets.push({ configDir: ambientConfigDir })
  }
  for (const account of settings?.claudeManagedAccounts ?? []) {
    const target = getClaudeManagedAccountHookTarget(account)
    if (target) {
      targets.push(target)
    }
  }
  targets.push(...recordedClaudeWslSystemDefaultHookTargets)
  if (options.includeWslSystemDefaultDiscovery !== false) {
    targets.push(...getWslSystemDefaultClaudeHookTargets(settings))
  }
  return dedupeClaudeHookTargets(targets)
}

function getClaudeManagedAccountHookTarget(
  account: ClaudeManagedAccount
): ClaudeLocalHookTarget | null {
  if (account.managedAuthRuntime === 'wsl') {
    if (!account.wslLinuxAuthPath) {
      return null
    }
    return {
      configDir: account.managedAuthPath,
      runtime: 'wsl',
      wslLinuxConfigDir: account.wslLinuxAuthPath
    }
  }
  return { configDir: account.managedAuthPath }
}

function getWslSystemDefaultClaudeHookTargets(
  settings: ManagedHookSettings | undefined
): ClaudeLocalHookTarget[] {
  const distroKeys = new Set(
    Object.keys(settings?.activeClaudeManagedAccountIdsByRuntime?.wsl ?? {})
  )
  for (const account of settings?.claudeManagedAccounts ?? []) {
    if (account.managedAuthRuntime === 'wsl') {
      distroKeys.add(account.wslDistro?.trim() || '__default__')
    }
  }
  if (settings?.localAccountRuntime === 'wsl') {
    distroKeys.add(settings.localAccountWslDistro?.trim() || '__default__')
  }

  return Array.from(distroKeys).flatMap((distroKey) => {
    if (!wslSystemDefaultHookTargetResolver) {
      return []
    }
    const distro =
      distroKey === '__default__'
        ? wslSystemDefaultHookTargetResolver.getDefaultWslDistro()
        : distroKey
    if (!distro) {
      return []
    }
    const wslHome = wslSystemDefaultHookTargetResolver.getWslHome(distro)
    const wslHomeInfo = wslHome ? parseWslUncPath(wslHome) : null
    if (!wslHome || !wslHomeInfo) {
      return []
    }
    return [
      {
        configDir: pathWin32.join(wslHome, '.claude'),
        runtime: 'wsl' as const,
        wslLinuxConfigDir: pathPosix.join(wslHomeInfo.linuxPath, '.claude')
      }
    ]
  })
}

function dedupeClaudeHookTargets(targets: ClaudeLocalHookTarget[]): ClaudeLocalHookTarget[] {
  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = getConfigPath(CLAUDE_HOOK_SETTINGS, target)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function removeClaudeHooksFromKnownConfigDirs(
  settings: ManagedHookSettings | undefined,
  options: ManagedHookRemovalOptions = {}
): AgentHookInstallStatus[] {
  const statuses: AgentHookInstallStatus[] = []
  // Why: launch-time repair may have written hooks into selected Claude
  // account config dirs; the global off switch must not leave those known
  // namespaces armed, but it also must not crawl or delete unrelated dirs.
  for (const target of getClaudeHookRemovalTargets(settings, options)) {
    try {
      statuses.push(removeClaudeHooksFromTarget(target))
    } catch (error) {
      statuses.push(errorStatus('claude', error, getConfigPath(CLAUDE_HOOK_SETTINGS, target)))
    }
  }
  return statuses
}

function removeClaudeHooksFromTarget(target: ClaudeLocalHookTarget): AgentHookInstallStatus {
  return Object.keys(target).length === 0
    ? claudeHookService.remove()
    : claudeHookService.remove(target)
}

export function recordClaudeWslSystemDefaultHookTarget(target: ClaudeLocalHookTarget): void {
  if (target.runtime !== 'wsl' || !target.configDir || !target.wslLinuxConfigDir) {
    return
  }
  if (
    recordedClaudeWslSystemDefaultHookTargets.some(
      (recorded) =>
        getConfigPath(CLAUDE_HOOK_SETTINGS, recorded) ===
        getConfigPath(CLAUDE_HOOK_SETTINGS, target)
    )
  ) {
    return
  }
  recordedClaudeWslSystemDefaultHookTargets.push(target)
}

export function clearRecordedClaudeWslSystemDefaultHookTargetsForTests(): void {
  recordedClaudeWslSystemDefaultHookTargets.length = 0
}

export function setWslSystemDefaultHookTargetResolver(
  resolver: WslSystemDefaultHookTargetResolver | null
): void {
  wslSystemDefaultHookTargetResolver = resolver
}

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
  ['devin', () => devinHookService.getStatus()],
  ['kimi', () => kimiHookService.getStatus()]
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

function errorStatus(
  agent: HookInstallAgent,
  error: unknown,
  configPath = ''
): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath,
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

export function removeManagedAgentHooks(
  settings?: ManagedHookSettings,
  options: ManagedHookRemovalOptions = {}
): AgentHookInstallStatus[] {
  return LOCAL_MANAGED_HOOK_REMOVERS.flatMap(([agent, remove]) => {
    try {
      if (agent === 'claude') {
        return removeClaudeHooksFromKnownConfigDirs(settings, options)
      }
      return remove(settings)
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

export function applyAgentStatusHooksEnabled(
  enabled: boolean,
  settings?: ManagedHookSettings,
  options: ManagedHookRemovalOptions = {}
): AgentHookInstallStatus[] {
  if (enabled) {
    installManagedAgentHooks()
    return getManagedAgentHookStatuses()
  }
  return removeManagedAgentHooks(settings, options)
}
