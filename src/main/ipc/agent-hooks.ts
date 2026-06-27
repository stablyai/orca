import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type {
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import { ampHookService } from '../amp/hook-service'
import {
  clearMigrationUnsupportedPtysByTabPrefix,
  clearMigrationUnsupportedPtysForPaneKey,
  getMigrationUnsupportedPtySnapshot
} from '../agent-hooks/migration-unsupported-pty-state'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { droidHookService } from '../droid/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { grokHookService } from '../grok/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { devinHookService } from '../devin/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'

type AgentStatusRuntimeEnrichment = Pick<
  OrcaRuntimeService,
  'getAgentStatusTerminalHandleForPaneKey' | 'getAgentStatusOrchestrationContextForPaneKey'
>

const MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH = 160

function enrichAgentStatusIpcPayload(
  data: AgentStatusIpcPayload,
  runtime: AgentStatusRuntimeEnrichment | undefined
): AgentStatusIpcPayload {
  if (!runtime) {
    return data
  }
  const terminalHandle = runtime.getAgentStatusTerminalHandleForPaneKey(data.paneKey)
  const orchestration = runtime.getAgentStatusOrchestrationContextForPaneKey(data.paneKey)
  return {
    ...data,
    ...(terminalHandle ? { terminalHandle } : {}),
    ...(orchestration ? { orchestration } : {})
  }
}

function isValidAgentStatusDropTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_AGENT_STATUS_DROP_TAB_ID_LENGTH &&
    value.trim() === value &&
    isValidTerminalTabId(value)
  )
}

// Why: install/remove are intentionally not exposed to the renderer. Orca
// auto-installs managed hooks at app startup (see src/main/index.ts), so a
// renderer-triggered remove would be silently reverted on the next launch
// and mislead the user.
export function registerAgentHookHandlers(runtime?: AgentStatusRuntimeEnrichment): void {
  // Why: matches the defensive pattern in src/main/ipc/pty.ts so re-registration
  // never throws "Attempted to register a second handler..." if this function is
  // ever invoked more than once (e.g. the macOS app re-activation path that
  // recreates the main window). Today the module-level `registered` guard in
  // register-core-handlers.ts prevents re-entry, but decoupling from that guard
  // future-proofs this file.
  ipcMain.removeHandler('agentHooks:claudeStatus')
  ipcMain.removeHandler('agentHooks:openClaudeStatus')
  ipcMain.removeHandler('agentHooks:codexStatus')
  ipcMain.removeHandler('agentHooks:geminiStatus')
  ipcMain.removeHandler('agentHooks:antigravityStatus')
  ipcMain.removeHandler('agentHooks:ampStatus')
  ipcMain.removeHandler('agentHooks:cursorStatus')
  ipcMain.removeHandler('agentHooks:droidStatus')
  ipcMain.removeHandler('agentHooks:commandCodeStatus')
  ipcMain.removeHandler('agentHooks:grokStatus')
  ipcMain.removeHandler('agentHooks:copilotStatus')
  ipcMain.removeHandler('agentHooks:hermesStatus')
  ipcMain.removeHandler('agentHooks:devinStatus')
  ipcMain.removeHandler('agentHooks:kimiStatus')
  ipcMain.removeHandler('agentStatus:getSnapshot')
  ipcMain.removeHandler('agentStatus:inferInterrupt')
  ipcMain.removeHandler('agentStatus:getMigrationUnsupportedSnapshot')
  // Why: agentStatus:drop is sent fire-and-forget from the renderer via
  // ipcRenderer.send(); we listen with ipcMain.on (not handle) so we don't
  // round-trip a response. Removing first keeps re-registration safe even
  // though the module-level registered guard already prevents re-entry today.
  ipcMain.removeAllListeners('agentStatus:drop')
  ipcMain.removeAllListeners('agentStatus:dropByTabPrefix')
  ipcMain.on('agentStatus:drop', (_event, paneKey: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      // Why: dropStatusEntry (not clearPaneState) is correct here — the user is
      // dismissing a status row, not tearing down a PTY. clearPaneState would also
      // wipe the per-pane prompt/tool caches, which the next hook event for that
      // (still-alive) pane needs to render a coherent row.
      agentHookServer.dropStatusEntry(paneKey)
      clearMigrationUnsupportedPtysForPaneKey(paneKey)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntry failed:', err)
    }
  })
  ipcMain.on('agentStatus:dropByTabPrefix', (_event, tabId: unknown) => {
    if (!isValidAgentStatusDropTabId(tabId)) {
      return
    }
    try {
      agentHookServer.dropStatusEntriesByTabPrefix(tabId)
      clearMigrationUnsupportedPtysByTabPrefix(tabId)
    } catch (err) {
      console.warn('[agent-hooks] dropStatusEntriesByTabPrefix failed:', err)
    }
  })
  ipcMain.handle('agentStatus:getSnapshot', (): AgentStatusIpcPayload[] => {
    // Why: the renderer pulls this after workspace hydration, so startup cannot
    // lose replayed statuses while its local store is still empty. Match the
    // live push enrichment in main/index.ts so parent/child rows survive replay.
    return agentHookServer
      .getStatusSnapshot()
      .map((entry) => enrichAgentStatusIpcPayload(entry, runtime))
  })
  ipcMain.handle('agentStatus:inferInterrupt', (_event, request: unknown): boolean => {
    if (typeof request !== 'object' || request === null) {
      return false
    }
    return agentHookServer.inferInterrupt(request as AgentInterruptInferenceRequest)
  })
  ipcMain.handle(
    'agentStatus:getMigrationUnsupportedSnapshot',
    (): MigrationUnsupportedPtyEntry[] => getMigrationUnsupportedPtySnapshot()
  )

  // Why: errors from getStatus() (fs permission denied, homedir resolution
  // failure, etc.) must be reported inline via state:'error' so the sidebar can
  // render a coherent per-agent error row. Letting the exception propagate out
  // of the IPC handler surfaces as an unhandled renderer-side rejection, which
  // defeats the AgentHookInstallStatus contract the UI relies on.
  ipcMain.handle('agentHooks:claudeStatus', (): AgentHookInstallStatus => {
    try {
      return claudeHookService.getStatus()
    } catch (err) {
      return {
        agent: 'claude',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:openClaudeStatus', (): AgentHookInstallStatus => {
    try {
      return openClaudeHookService.getStatus()
    } catch (err) {
      return {
        agent: 'openclaude',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:codexStatus', (): AgentHookInstallStatus => {
    try {
      return codexHookService.getStatus()
    } catch (err) {
      return {
        agent: 'codex',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:geminiStatus', (): AgentHookInstallStatus => {
    try {
      return geminiHookService.getStatus()
    } catch (err) {
      return {
        agent: 'gemini',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:antigravityStatus', (): AgentHookInstallStatus => {
    try {
      return antigravityHookService.getStatus()
    } catch (err) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:ampStatus', (): AgentHookInstallStatus => {
    try {
      return ampHookService.getStatus()
    } catch (err) {
      return {
        agent: 'amp',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:cursorStatus', (): AgentHookInstallStatus => {
    try {
      return cursorHookService.getStatus()
    } catch (err) {
      return {
        agent: 'cursor',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:droidStatus', (): AgentHookInstallStatus => {
    try {
      return droidHookService.getStatus()
    } catch (err) {
      return {
        agent: 'droid',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:commandCodeStatus', (): AgentHookInstallStatus => {
    try {
      return commandCodeHookService.getStatus()
    } catch (err) {
      return {
        agent: 'command-code',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:grokStatus', (): AgentHookInstallStatus => {
    try {
      return grokHookService.getStatus()
    } catch (err) {
      return {
        agent: 'grok',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:copilotStatus', (): AgentHookInstallStatus => {
    try {
      return copilotHookService.getStatus()
    } catch (err) {
      return {
        agent: 'copilot',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:hermesStatus', (): AgentHookInstallStatus => {
    try {
      return hermesHookService.getStatus()
    } catch (err) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:devinStatus', (): AgentHookInstallStatus => {
    try {
      return devinHookService.getStatus()
    } catch (err) {
      return {
        agent: 'devin',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('agentHooks:kimiStatus', (): AgentHookInstallStatus => {
    try {
      return kimiHookService.getStatus()
    } catch (err) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath: '',
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  })
}
