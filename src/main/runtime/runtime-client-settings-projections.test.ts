import { vi } from 'vitest'
import './runtime-client-settings-linear-team-projection.spec'

vi.mock('../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
