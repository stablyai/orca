import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  removeHandler: vi.fn(),
  handle: vi.fn(),
  markClaudeProjectTrusted: vi.fn(),
  markCodexProjectTrusted: vi.fn(),
  markCopilotFolderTrusted: vi.fn(),
  markCursorWorkspaceTrusted: vi.fn(),
  markRemoteAgentWorkspaceTrusted: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: mocks.removeHandler,
    handle: mocks.handle
  }
}))

vi.mock('../agent-trust-presets', () => ({
  markClaudeProjectTrusted: mocks.markClaudeProjectTrusted,
  markCodexProjectTrusted: mocks.markCodexProjectTrusted,
  markCopilotFolderTrusted: mocks.markCopilotFolderTrusted,
  markCursorWorkspaceTrusted: mocks.markCursorWorkspaceTrusted
}))

vi.mock('../remote-agent-trust-presets', () => ({
  markRemoteAgentWorkspaceTrusted: mocks.markRemoteAgentWorkspaceTrusted
}))

import { registerAgentTrustHandlers } from './agent-trust'

describe('registerAgentTrustHandlers', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes Claude trust locally when the renderer requests the Claude preset', async () => {
    registerAgentTrustHandlers()
    const handler = mocks.handle.mock.calls[0]?.[1]

    await handler({}, { preset: 'claude', workspacePath: '/repo/worktree' })

    expect(mocks.markClaudeProjectTrusted).toHaveBeenCalledWith('/repo/worktree')
    expect(mocks.markRemoteAgentWorkspaceTrusted).not.toHaveBeenCalled()
  })
})
