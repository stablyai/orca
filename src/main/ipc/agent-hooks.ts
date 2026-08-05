import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type {
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../shared/agent-question-answered-intent'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
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
import { qwenCodeHookService } from '../qwen/hook-service'
import { registerAgentPaneAuthorityIpcHandlers } from './agent-pane-authority-ipc'
import { createAgentPaneAuthorityOwnership } from './agent-pane-authority-ownership'
import {
  enrichAgentStatusIpcPayload,
  isValidAgentStatusDropTabId,
  type AgentStatusRuntimeEnrichment
} from './agent-status-ipc-boundary'

type AgentHookHandlerDependencies = {
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
}

type AgentHookStatusHandlerRegistration = readonly [
  string,
  AgentHookInstallStatus['agent'],
  () => AgentHookInstallStatus
]

// Why: install/remove are intentionally not exposed to the renderer. Orca
// auto-installs managed hooks at app startup (see src/main/index.ts), so a
// renderer-triggered remove would be silently reverted on the next launch
// and mislead the user.
export function registerAgentHookHandlers(
  runtime?: AgentStatusRuntimeEnrichment,
  dependencies: AgentHookHandlerDependencies = {}
): void {
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
  ipcMain.removeHandler('agentHooks:qwenCodeStatus')
  ipcMain.removeHandler('agentStatus:getSnapshot')
  ipcMain.removeHandler('agentStatus:inferInterrupt')
  ipcMain.removeHandler('agentStatus:inferQuestionAnswered')
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
  registerAgentPaneAuthorityIpcHandlers({
    ownsPty: createAgentPaneAuthorityOwnership({
      getPtyIdForPaneKey: dependencies.getPtyIdForPaneKey,
      getRuntimeTerminalHandleForPaneKey: (paneKey) =>
        runtime?.getAgentStatusTerminalHandleForPaneKey(paneKey)
    })
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
  ipcMain.handle('agentStatus:inferQuestionAnswered', (_event, request: unknown): boolean => {
    if (typeof request !== 'object' || request === null) {
      return false
    }
    return agentHookServer.inferQuestionAnswered(request as AgentQuestionAnsweredInferenceRequest)
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
  const statusHandlers: readonly AgentHookStatusHandlerRegistration[] = [
    ['agentHooks:claudeStatus', 'claude', () => claudeHookService.getStatus()],
    ['agentHooks:openClaudeStatus', 'openclaude', () => openClaudeHookService.getStatus()],
    ['agentHooks:codexStatus', 'codex', () => codexHookService.getStatus()],
    ['agentHooks:geminiStatus', 'gemini', () => geminiHookService.getStatus()],
    ['agentHooks:antigravityStatus', 'antigravity', () => antigravityHookService.getStatus()],
    ['agentHooks:ampStatus', 'amp', () => ampHookService.getStatus()],
    ['agentHooks:cursorStatus', 'cursor', () => cursorHookService.getStatus()],
    ['agentHooks:droidStatus', 'droid', () => droidHookService.getStatus()],
    ['agentHooks:commandCodeStatus', 'command-code', () => commandCodeHookService.getStatus()],
    ['agentHooks:grokStatus', 'grok', () => grokHookService.getStatus()],
    ['agentHooks:copilotStatus', 'copilot', () => copilotHookService.getStatus()],
    ['agentHooks:hermesStatus', 'hermes', () => hermesHookService.getStatus()],
    ['agentHooks:devinStatus', 'devin', () => devinHookService.getStatus()],
    ['agentHooks:kimiStatus', 'kimi', () => kimiHookService.getStatus()],
    ['agentHooks:qwenCodeStatus', 'qwen-code', () => qwenCodeHookService.getStatus()]
  ]
  for (const [channel, agent, getStatus] of statusHandlers) {
    ipcMain.handle(channel, (): AgentHookInstallStatus => {
      try {
        return getStatus()
      } catch (err) {
        return {
          agent,
          state: 'error',
          configPath: '',
          managedHooksPresent: false,
          detail: err instanceof Error ? err.message : String(err)
        }
      }
    })
  }
}
