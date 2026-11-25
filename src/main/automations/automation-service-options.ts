import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationUsageClient } from '../../shared/backend/backend-service-contract'
import type { PublishAutomationsChanged } from '../../shared/remote-runtime/session-graph/runtime-client-events'
import type { AutomationService } from './automation-service'
import type { requestAutomationDispatch } from './dispatch/automation-dispatch-request'
import type {
  AutomationBotLauncher,
  AutomationLauncher,
  AutomationTerminalLauncher
} from './launch/automation-launch'
import type { AutomationRunTerminalObserver } from './observation/run-completion-watcher'
import type { RunTerminalRetention } from './terminal-retention/run-terminal-retention'

export type AutomationServiceOptions = {
  tickMs?: number
  claudeUsage?: AutomationUsageClient
  codexUsage?: AutomationUsageClient
  allowRemoteHostScheduling?: boolean
  terminalLauncher?: AutomationTerminalLauncher
  botDispatcher?: AutomationBotLauncher
  onRunRefused?: (automation: Automation, error: string) => void
  chatDispatcher?: AutomationLauncher
  prepareCodexRun?: Parameters<typeof requestAutomationDispatch>[0]['prepareCodexRun']
  terminalObserver?: AutomationRunTerminalObserver
  isHostQuitting?: () => boolean
  onAutomationsChanged?: PublishAutomationsChanged
  runTerminalRetention?: (service: AutomationService) => RunTerminalRetention
}
