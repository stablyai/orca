// Install/remove/status lifecycle for managed hooks in discovered alternate
// Claude config dirs (`~/.claude-<name>`), joining the same
// agentStatusHooksEnabled-gated flow as the static per-agent services.
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { ClaudeHookService } from './hook-service'
import { createClaudeConfigDirHookService } from './claude-config-dir-hook-service'
import {
  discoverLocalClaudeConfigDirNames,
  type LocalClaudeConfigDirFs
} from './claude-config-dir-discovery'

export type ClaudeConfigDirHookControlsDeps = {
  homeDir?: string
  discoveryFs?: LocalClaudeConfigDirFs
  createService?: (dirName: string) => Pick<ClaudeHookService, 'install' | 'remove' | 'getStatus'>
}

function errorStatus(configDirName: string, error: unknown): AgentHookInstallStatus {
  return {
    agent: 'claude',
    state: 'error',
    configPath: configDirName,
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

function runForDiscoveredConfigDirs(
  operation: 'install' | 'remove' | 'getStatus',
  deps: ClaudeConfigDirHookControlsDeps
): AgentHookInstallStatus[] {
  const createService = deps.createService ?? createClaudeConfigDirHookService
  return discoverLocalClaudeConfigDirNames(deps.homeDir, deps.discoveryFs).map((dirName) => {
    try {
      return createService(dirName)[operation]()
    } catch (error) {
      return errorStatus(dirName, error)
    }
  })
}

/** Discover flavor config dirs and install managed hooks into each. */
export function installDiscoveredClaudeConfigDirHooks(
  deps: ClaudeConfigDirHookControlsDeps = {}
): AgentHookInstallStatus[] {
  return runForDiscoveredConfigDirs('install', deps).map((status) => {
    if (status.state === 'error') {
      // Why: name-free warn (dir names are user-private observed data) —
      // mirrors the remote flow so a failing flavor-dir install is visible
      // at install time, not only via the aggregated status.
      console.warn('[agent-hooks] Claude managed hook install failed for a discovered config dir')
    }
    return status
  })
}

/** Remove managed hooks from every discovered config dir. Successful installs
 *  create settings.json, so discovery remains the cleanup source of truth. */
export function removeDiscoveredClaudeConfigDirHooks(
  deps: ClaudeConfigDirHookControlsDeps = {}
): AgentHookInstallStatus[] {
  return runForDiscoveredConfigDirs('remove', deps)
}

export function getDiscoveredClaudeConfigDirHookStatuses(
  deps: ClaudeConfigDirHookControlsDeps = {}
): AgentHookInstallStatus[] {
  return runForDiscoveredConfigDirs('getStatus', deps)
}

export function aggregateClaudeHookRemovalStatus(
  primary: AgentHookInstallStatus,
  configDirStatuses: AgentHookInstallStatus[]
): AgentHookInstallStatus {
  const failed = configDirStatuses.filter((status) => status.state === 'error').length
  if (failed === 0 || primary.state === 'error') {
    return primary
  }
  const detail = `managed hook removal failed in ${failed} discovered Claude config dir(s)`
  return {
    ...primary,
    state: 'partial',
    detail: primary.detail ? `${primary.detail}; ${detail}` : detail
  }
}

/** Fold discovered-dir statuses into the primary `.claude` status so the
 *  existing single-row-per-agent UI surfaces a degraded multi-dir install.
 *  Why count-only detail: dir names are user-private observed data and must
 *  not be echoed into status text or logs. */
export function aggregateClaudeHookStatusWithConfigDirs(
  primary: AgentHookInstallStatus,
  configDirStatuses: AgentHookInstallStatus[]
): AgentHookInstallStatus {
  const broken = configDirStatuses.filter((status) => status.state !== 'installed').length
  if (broken === 0 || (primary.state !== 'installed' && primary.state !== 'partial')) {
    return primary
  }
  const brokenDetail = `managed hooks missing or broken in ${broken} discovered Claude config dir(s)`
  return {
    ...primary,
    state: 'partial',
    detail: primary.detail ? `${primary.detail}; ${brokenDetail}` : brokenDetail
  }
}
