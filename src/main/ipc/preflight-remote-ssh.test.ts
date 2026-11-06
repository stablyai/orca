import { describe, expect, it, vi } from 'vitest'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'

type Handler = (event: unknown, args: unknown) => Promise<unknown>
const { handlers, isCommandOnPathMock } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  isCommandOnPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
}))
vi.mock('./preflight-command-exec', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isCommandOnPath: isCommandOnPathMock
}))

import { registerPreflightHandlers } from './preflight'
import { detectAgentCommandsOnHost } from '../preflight/agent-detection'

// This process cannot answer for the SSH host; never substitute local results.
describe('preflight on an SSH target', () => {
  it('refuses Qoder command selection without probing the local host', async () => {
    await expect(
      detectAgentCommandsOnHost(['qodercli', 'qoder'], { connectionId: 'ssh-qoder' })
    ).rejects.toThrow(SSH_HOST_NOT_SERVED_MESSAGE)
    expect(isCommandOnPathMock).not.toHaveBeenCalled()
  })

  // Empty results would be cached as no agents installed on that host (#25523).
  it.each(['preflight:detectRemoteAgents', 'preflight:detectRemoteWindowsTerminalCapabilities'])(
    '%s rejects instead of answering',
    async (channel) => {
      registerPreflightHandlers()
      await expect(handlers.get(channel)!(undefined, { connectionId: 'ssh-1' })).rejects.toThrow(
        SSH_HOST_NOT_SERVED_MESSAGE
      )
      expect(isCommandOnPathMock).not.toHaveBeenCalled()
    }
  )
})
