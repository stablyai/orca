import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  copilot: vi.fn<(path: string) => void>()
}))

vi.mock('../shared/home-or-filesystem-root', () => ({
  isTooBroadToPreTrust: () => {
    throw new Error('homedir unavailable')
  }
}))
vi.mock('./agent-trust-presets', () => ({
  markCodexProjectTrusted: vi.fn(async () => {}),
  markCursorWorkspaceTrusted: vi.fn(),
  markCopilotFolderTrusted: mocks.copilot,
  markAntigravityWorkspaceTrusted: vi.fn()
}))

import { applyAgentWorkspaceTrust } from './agent-workspace-trust'

describe('applyAgentWorkspaceTrust when the breadth guard fails', () => {
  it('writes nothing and never fails the launch', async () => {
    await expect(
      applyAgentWorkspaceTrust('copilot', '/workspace/app', {
        env: {},
        claudeAuth: null,
        wslDistro: null,
        connectionId: null
      })
    ).resolves.toEqual({})
    expect(mocks.copilot).not.toHaveBeenCalled()
  })
})
