import { describe, expect, it, vi } from 'vitest'

vi.mock('../shared/home-or-filesystem-root', () => ({
  isTooBroadToPreTrust: () => {
    throw new Error('homedir unavailable')
  }
}))

import { applyRelayAgentWorkspaceTrust } from './agent-workspace-trust-spawn'

describe('applyRelayAgentWorkspaceTrust when the breadth guard fails', () => {
  it.each(['claude', 'copilot', 'qoder'] as const)(
    'skips %s trust and never fails the spawn',
    async (agent) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(
        applyRelayAgentWorkspaceTrust({ workspacePath: '/srv/wt' }, agent, {}, { wslShell: false })
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    }
  )
})
