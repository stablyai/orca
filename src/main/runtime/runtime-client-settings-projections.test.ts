import { vi } from 'vitest'
import './runtime-client-settings-minimax-projection.spec'
import './runtime-client-settings-linear-team-projection.spec'
import './runtime-client-settings-source-control-projection.spec'

vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
