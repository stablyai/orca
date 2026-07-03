import { ipcMain } from 'electron'
import type { AgentHookInstallStatus, AgentHookTarget } from '../../shared/agent-hook-types'
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
import { verbooHookService } from '../verboo/hook-service'

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

// Why: every per-agent status channel shares the same try/catch contract, so
// table-drive them. A new Claude-family agent (e.g. Verboo) needs one row here
// instead of a copy-pasted handler block.
const AGENT_HOOK_STATUS_HANDLERS: readonly (readonly [
  channel: string,
  agent: AgentHookTarget,
  getStatus: () => AgentHookInstallStatus
])[] = [
  ['agentHooks:claudeStatus', 'claude', () => claudeHookService.getStatus()],
  ['agentHooks:openClaudeStatus', 'openclaude', () => openClaudeHookService.getStatus()],
  ['agentHooks:verbooStatus', 'verboo', () => verbooHookService.getStatus()],
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
  ['agentHooks:kimiStatus', 'kimi', () => kimiHookService.getStatus()]
]

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
  // Why: per-agent status channels are removed/registered by the table-driven
  // loop below; only the non-status channels need explicit removal here.
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
  for (const [channel, agent, getStatus] of AGENT_HOOK_STATUS_HANDLERS) {
    ipcMain.removeHandler(channel)
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
