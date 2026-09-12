import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import { mapRuntimeError } from './rpc/errors'

const desktop = vi.hoisted(() => ({ onIpc: vi.fn(), removeIpcListener: vi.fn() }))
vi.mock('./runtime-desktop-surface', () => ({ getRuntimeDesktopSurface: () => desktop }))
vi.mock('./orca-runtime-create-mobile-session-terminal', () => ({
  OrcaRuntimeWithCreateMobileSessionTerminal: class {}
}))
vi.mock('./orca-runtime-core', () => ({
  MOBILE_TERMINAL_READY_FALLBACK_MS: 1000,
  MOBILE_TERMINAL_SURFACE_TIMEOUT_MS: 1000,
  isClientDisconnectedError: () => false
}))

import { OrcaRuntimeWithRunCreateMobileSessionTerminal } from './orca-runtime-run-create-mobile-session-terminal'

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('mobile terminal create reply errors', () => {
  it.each(['worktree_not_renderable', undefined])(
    'preserves code %s before surface waiting',
    async (errorCode) => {
      vi.useFakeTimers()
      const win = {
        webContents: {
          isDestroyed: () => false,
          send: vi.fn((_channel, request) => {
            const handler = desktop.onIpc.mock.calls[0][1]
            handler({ sender: win.webContents }, {
              requestId: request.requestId,
              error: 'Show this worktree first',
              ...(errorCode ? { errorCode } : {})
            } satisfies TerminalTabCreateReply)
          })
        }
      }
      const release = vi.fn()
      const runtime = {
        captureReadyGraphEpoch: vi.fn(),
        resolveTerminalWorkspaceLaunchScope: vi.fn().mockResolvedValue({ id: 'hidden' }),
        resolveWorkspaceTerminalStartupCwd: vi.fn(),
        hydrateHeadlessMobileSessionTabsFromWorkspaceSession: vi.fn(),
        resolveMobileSessionTerminalCommand: vi.fn().mockResolvedValue({}),
        assertStableReadyGraph: vi.fn(),
        getAvailableAuthoritativeWindow: () => win,
        rendererPublicationThrottle: { acquire: () => release },
        waitForMobileTerminalSurface: vi.fn()
      }
      const run = (
        OrcaRuntimeWithRunCreateMobileSessionTerminal.prototype as unknown as {
          runCreateMobileSessionTerminal: (
            id: string,
            opts: { clientNavigationId: string }
          ) => Promise<unknown>
        }
      ).runCreateMobileSessionTerminal
      const error = await run
        .call(runtime, 'hidden', { clientNavigationId: 'navigation' })
        .catch((error: unknown) => error)
      expect(mapRuntimeError('request', { runtimeId: 'runtime' }, error)).toMatchObject({
        ok: false,
        error: { code: errorCode ?? 'runtime_error', message: 'Show this worktree first' }
      })
      expect(runtime.waitForMobileTerminalSurface).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledOnce()
      expect(desktop.removeIpcListener).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
