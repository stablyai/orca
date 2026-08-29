import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'

// Why: the old five-name example read as an allowlist (#15125); derive from the field detection keys on so it cannot drift.
// Not filtered by `disabledTuiAgents` — that gates Orca's launchers, not detection, so a hand-started disabled agent still injects.
const RECOGNIZED_AGENT_PROCESS_NAMES = [
  ...new Set(Object.values(TUI_AGENT_CONFIG).map((config) => config.expectedProcess))
].sort()

export function buildInjectRejectionMessage(terminal: string): string {
  return (
    `Cannot dispatch --inject to terminal ${terminal}: no recognized agent detected. ` +
    `Orca detects these agent CLIs (${RECOGNIZED_AGENT_PROCESS_NAMES.join(', ')}). ` +
    'Start one in the terminal and let it finish launching, ' +
    'or dispatch without --inject and send the prompt manually.'
  )
}
