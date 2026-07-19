// Install/remove/status lifecycle for managed hooks in discovered alternate
// Claude config dirs (`~/.claude-<name>`), joining the same
// agentStatusHooksEnabled-gated flow as the static per-agent services.
//
// The install ledger (a small JSON under userData/agent-hooks) records every
// dir Orca installed into, so uninstall cleans exactly the dirs it touched
// even when discovery results change later (marker deleted, dir renamed).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getDefaultOrcaUserDataPath } from '../../shared/orca-user-data-path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type { ClaudeHookService } from './hook-service'
import { createClaudeConfigDirHookService } from './hook-service'
import {
  discoverLocalClaudeConfigDirNames,
  isClaudeFlavorConfigDirName,
  type LocalClaudeConfigDirFs
} from './claude-config-dir-discovery'

export const CLAUDE_CONFIG_DIR_LEDGER_FILE_NAME = 'claude-config-dirs.json'

function getDefaultLedgerPath(): string {
  // Why: lives beside the hook server's endpoint files under
  // userData/agent-hooks — which dirs THIS Orca install wrote into is
  // per-install state, not per-user-home state.
  return join(resolveUserDataPath(), 'agent-hooks', CLAUDE_CONFIG_DIR_LEDGER_FILE_NAME)
}

function resolveUserDataPath(): string {
  // Why: this module is also compiled into the standalone `orca` CLI, which
  // runs as plain Node (ELECTRON_RUN_AS_NODE) and packaged installs ship no
  // electron module — a static electron import would crash every CLI command.
  // Lazy-require electron and fall back to the shared userData convention so
  // the app and the offline CLI resolve the same ledger file.
  try {
    const electronApp = (require('electron') as { app?: { getPath(name: 'userData'): string } })
      .app
    if (electronApp) {
      return electronApp.getPath('userData')
    }
  } catch {
    // Not running under Electron.
  }
  return getDefaultOrcaUserDataPath()
}

export type ClaudeConfigDirHookControlsDeps = {
  homeDir?: string
  discoveryFs?: LocalClaudeConfigDirFs
  ledgerPath?: string
  createService?: (dirName: string) => Pick<ClaudeHookService, 'install' | 'remove' | 'getStatus'>
}

export function readClaudeConfigDirLedger(ledgerPath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
      configDirNames?: unknown
    }
    if (Array.isArray(parsed?.configDirNames)) {
      // Why: re-validate against the naming convention on read — a corrupted
      // or tampered ledger must never drive writes into `.claude` itself or
      // an arbitrary directory.
      return parsed.configDirNames.filter(
        (name): name is string => typeof name === 'string' && isClaudeFlavorConfigDirName(name)
      )
    }
  } catch {
    // Missing or corrupt ledger — treat as empty.
  }
  return []
}

function writeClaudeConfigDirLedger(ledgerPath: string, dirNames: string[]): void {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({ version: 1, configDirNames: dirNames }, null, 2)}\n`,
    'utf-8'
  )
}

function configDirStillExists(
  homeDir: string,
  dirName: string,
  fs?: LocalClaudeConfigDirFs
): boolean {
  try {
    return (fs?.pathExists ?? existsSync)(join(homeDir, dirName))
  } catch {
    // Probe failure is not proof of deletion — keep the entry tracked.
    return true
  }
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

/** Discover flavor config dirs, install managed hooks into each, and record
 *  them in the ledger. The ledger keeps the union of previously tracked and
 *  newly discovered dirs and is written BEFORE installing, so a crash
 *  mid-install still leaves every touched dir tracked for cleanup. */
export function installDiscoveredClaudeConfigDirHooks(
  deps: ClaudeConfigDirHookControlsDeps = {}
): AgentHookInstallStatus[] {
  const ledgerPath = deps.ledgerPath ?? getDefaultLedgerPath()
  const createService = deps.createService ?? createClaudeConfigDirHookService
  const homeDir = deps.homeDir ?? homedir()
  const discovered = discoverLocalClaudeConfigDirNames(homeDir, deps.discoveryFs)
  // Why: prune ledger entries whose dir the user deleted entirely — nothing is
  // left to clean there, and keeping them would pin the aggregated claude
  // status at 'partial' forever.
  const stillPresent = readClaudeConfigDirLedger(ledgerPath).filter((dirName) =>
    configDirStillExists(homeDir, dirName, deps.discoveryFs)
  )
  const tracked = [...new Set([...stillPresent, ...discovered])].sort()
  writeClaudeConfigDirLedger(ledgerPath, tracked)
  return discovered.map((dirName) => {
    let status: AgentHookInstallStatus
    try {
      status = createService(dirName).install()
    } catch (error) {
      status = errorStatus(dirName, error)
    }
    if (status.state === 'error') {
      // Why: name-free warn (dir names are user-private observed data) —
      // mirrors the remote flow so a failing flavor-dir install is visible
      // at install time, not only via the aggregated status.
      console.warn('[agent-hooks] Claude managed hook install failed for a discovered config dir')
    }
    return status
  })
}

/** Remove managed hooks from exactly the ledgered dirs and clear the ledger.
 *  Dirs whose removal failed stay ledgered for a later retry. */
export function removeLedgeredClaudeConfigDirHooks(
  deps: ClaudeConfigDirHookControlsDeps = {}
): AgentHookInstallStatus[] {
  const ledgerPath = deps.ledgerPath ?? getDefaultLedgerPath()
  const createService = deps.createService ?? createClaudeConfigDirHookService
  const statuses: AgentHookInstallStatus[] = []
  const remaining: string[] = []
  for (const dirName of readClaudeConfigDirLedger(ledgerPath)) {
    let status: AgentHookInstallStatus
    try {
      status = createService(dirName).remove()
    } catch (error) {
      status = errorStatus(dirName, error)
    }
    if (status.state === 'error') {
      remaining.push(dirName)
    }
    statuses.push(status)
  }
  writeClaudeConfigDirLedger(ledgerPath, remaining)
  return statuses
}

export function getLedgeredClaudeConfigDirHookStatuses(
  deps: ClaudeConfigDirHookControlsDeps = {}
): AgentHookInstallStatus[] {
  const ledgerPath = deps.ledgerPath ?? getDefaultLedgerPath()
  const createService = deps.createService ?? createClaudeConfigDirHookService
  const homeDir = deps.homeDir ?? homedir()
  return (
    readClaudeConfigDirLedger(ledgerPath)
      // Why: a ledgered dir the user deleted must not surface a permanent
      // degraded status; the next install() run prunes it from the ledger.
      .filter((dirName) => configDirStillExists(homeDir, dirName, deps.discoveryFs))
      .map((dirName) => {
        try {
          return createService(dirName).getStatus()
        } catch (error) {
          return errorStatus(dirName, error)
        }
      })
  )
}

/** Fold ledgered-dir statuses into the primary `.claude` status so the
 *  existing single-row-per-agent UI surfaces a degraded multi-dir install.
 *  Why count-only detail: dir names are user-private observed data and must
 *  not be echoed into status text or logs. */
export function aggregateClaudeHookStatusWithConfigDirs(
  primary: AgentHookInstallStatus,
  configDirStatuses: AgentHookInstallStatus[]
): AgentHookInstallStatus {
  const broken = configDirStatuses.filter((status) => status.state !== 'installed').length
  if (broken === 0 || primary.state === 'error') {
    return primary
  }
  const brokenDetail = `managed hooks missing or broken in ${broken} discovered Claude config dir(s)`
  return {
    ...primary,
    state: primary.state === 'installed' ? 'partial' : primary.state,
    detail: primary.detail ? `${primary.detail}; ${brokenDetail}` : brokenDetail
  }
}
