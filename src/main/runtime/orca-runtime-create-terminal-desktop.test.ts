import { describe, expect, it, vi } from 'vitest'
import { describeLaunchFileUnavailable } from '../../shared/launch-prompt-file'

const surface = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, response: unknown) => void>()
  return {
    handlers,
    onIpc: (channel: string, handler: (event: unknown, response: unknown) => void) =>
      handlers.set(channel, handler),
    removeIpcListener: vi.fn()
  }
})

vi.mock('./orca-runtime-create-terminal-dependencies', () => ({
  randomUUID: () => 'request-1',
  ownerSurfacing: () => ({}),
  getRuntimeDesktopSurface: () => surface
}))

import { createDesktopTerminal } from './orca-runtime-create-terminal-desktop'

describe('a desktop terminal create whose pane the host refused', () => {
  // Why: the pane never started, so closing its tab is what makes the refusal a launch without
  // effects, and lets the phone's replay be told the reason instead of "outcome unknown".
  it('closes the tab it opened and reports the refusal', async () => {
    const refusal = new Error(describeLaunchFileUnavailable('disk full'))
    const webContents = {
      send: (_channel: string, request: { requestId: string }) =>
        surface.handlers.get('terminal:tabCreateReply')?.(
          { sender: webContents },
          { requestId: request.requestId, tabId: 'tab-refused' }
        )
    }
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = {
      assertGraphReady: () => {},
      getAuthoritativeWindow: () => ({ webContents }),
      resolveTerminalWorkspaceLaunchScope: async () => null,
      waitForTerminalHandle: vi.fn(async () => {
        throw refusal
      }),
      notifier: { closeTerminalTab }
    }

    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reads only the members stubbed above.
      createDesktopTerminal(runtime as never, undefined, { command: 'claude' }, undefined, null)
    ).rejects.toBe(refusal)
    expect(closeTerminalTab).toHaveBeenCalledWith('tab-refused', { force: true })
  })

  it('leaves the tab of any other failure', async () => {
    const webContents = {
      send: (_channel: string, request: { requestId: string }) =>
        surface.handlers.get('terminal:tabCreateReply')?.(
          { sender: webContents },
          { requestId: request.requestId, tabId: 'tab-slow' }
        )
    }
    const closeTerminalTab = vi.fn(async () => {})
    const runtime = {
      assertGraphReady: () => {},
      getAuthoritativeWindow: () => ({ webContents }),
      resolveTerminalWorkspaceLaunchScope: async () => null,
      waitForTerminalHandle: vi.fn(async () => {
        throw new Error('Timed out waiting for terminal handle after creation')
      }),
      notifier: { closeTerminalTab }
    }

    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reads only the members stubbed above.
      createDesktopTerminal(runtime as never, undefined, { command: 'claude' }, undefined, null)
    ).rejects.toThrow('Timed out')
    expect(closeTerminalTab).not.toHaveBeenCalled()
  })
})
