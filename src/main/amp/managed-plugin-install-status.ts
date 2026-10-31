import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { AMP_PLUGIN_FILE, AMP_PLUGIN_MARKER } from './agent-status-plugin-source'

export type PluginFileState =
  | { kind: 'absent' }
  | { kind: 'managed'; complete: boolean }
  | { kind: 'unmanaged' }
  | { kind: 'error'; detail: string }

export function getPluginPath(): string {
  return join(homedir(), '.config', 'amp', 'plugins', AMP_PLUGIN_FILE)
}

export function getRemotePluginPath(remoteHome: string): string {
  const home = remoteHome.replace(/\/$/, '')
  return `${home}/.config/amp/plugins/${AMP_PLUGIN_FILE}`
}

export function isManagedPlugin(content: string): boolean {
  return content.includes(AMP_PLUGIN_MARKER)
}

function isCompleteManagedPlugin(content: string): boolean {
  return (
    isManagedPlugin(content) &&
    content.includes('/hook/amp') &&
    content.includes("amp.on('session.start'") &&
    content.includes("amp.on('agent.start'") &&
    content.includes("amp.on('tool.call'") &&
    content.includes("amp.on('tool.result'") &&
    content.includes("amp.on('agent.end'")
  )
}

export function readLocalPluginState(pluginPath: string): PluginFileState {
  if (!existsSync(pluginPath)) {
    return { kind: 'absent' }
  }
  try {
    const content = readFileSync(pluginPath, 'utf-8')
    if (!isManagedPlugin(content)) {
      return { kind: 'unmanaged' }
    }
    return { kind: 'managed', complete: isCompleteManagedPlugin(content) }
  } catch (error) {
    return { kind: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

export function statusFromState(
  pluginPath: string,
  state: PluginFileState
): AgentHookInstallStatus {
  switch (state.kind) {
    case 'absent':
      return {
        agent: 'amp',
        state: 'not_installed',
        configPath: pluginPath,
        managedHooksPresent: false,
        detail: null
      }
    case 'managed':
      return {
        agent: 'amp',
        state: state.complete ? 'installed' : 'partial',
        configPath: pluginPath,
        managedHooksPresent: true,
        detail: state.complete ? null : 'Managed Amp plugin is missing required handlers'
      }
    case 'unmanaged':
      return {
        agent: 'amp',
        state: 'partial',
        configPath: pluginPath,
        managedHooksPresent: false,
        detail: 'Amp Orca status plugin exists but is not Orca-managed'
      }
    case 'error':
      return {
        agent: 'amp',
        state: 'error',
        configPath: pluginPath,
        managedHooksPresent: false,
        detail: state.detail
      }
  }
}
