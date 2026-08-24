import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import type {
  AgentStatusIpcPayload,
  MigrationUnsupportedPtyEntry
} from '../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../shared/agent-interrupt-intent'
import type { AgentQuestionAnsweredInferenceRequest } from '../../shared/agent-question-answered-intent'
import { agentHookServer } from '../agent-hooks/server'
import { ampHookService } from '../amp/hook-service'
import { auggieHookService } from '../auggie/hook-service'
import { getMigrationUnsupportedPtySnapshot } from '../agent-hooks/migration-unsupported-pty-state'
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
import { registerAgentPaneAuthorityIpcHandlers } from './agent-pane-authority-ipc'
import { registerAgentStatusRowTeardownIpcHandlers } from './agent-status-row-teardown-ipc'
import { createAgentPaneAuthorityOwnership } from './agent-pane-authority-ownership'
import {
  enrichAgentStatusIpcPayload,
  type AgentStatusRuntimeEnrichment
} from './agent-status-ipc-boundary'

type AgentHookHandlerDependencies = {
  getPtyIdForPaneKey?: (paneKey: string) => string | undefined
}

// Why: channel names are historical (openClaude/commandCode camel-case their agent id), so
// each entry names its channel explicitly instead of deriving it.
const AGENT_HOOK_STATUS_HANDLERS: readonly (readonly [
  string,
  AgentHookInstallStatus['agent'],
  () => AgentHookInstallStatus
])[] = [
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
  ['agentHooks:augStatus', 'aug', () => auggieHookService.getStatus()]
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
  for (const [channel] of AGENT_HOOK_STATUS_HANDLERS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.removeHandler('agentStatus:getSnapshot')
  ipcMain.removeHandler('agentStatus:inferInterrupt')
  ipcMain.removeHandler('agentStatus:inferQuestionAnswered')
  ipcMain.removeHandler('agentStatus:getMigrationUnsupportedSnapshot')
  registerAgentStatusRowTeardownIpcHandlers()
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
  for (const [channel, agent, getStatus] of AGENT_HOOK_STATUS_HANDLERS) {
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
