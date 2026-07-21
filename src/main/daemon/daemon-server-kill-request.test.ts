import { describe, expect, it, vi } from 'vitest'
import { DaemonServer } from './daemon-server'
import type { DaemonRequest } from './types'

type KillRequestRoute = {
  host: {
    getForegroundProcess(sessionId: string): string | null
    kill(sessionId: string, options?: { immediate?: boolean }): Promise<void>
  }
  routeRequest(clientId: string, request: DaemonRequest): Promise<unknown>
}

function createKillRequestRoute(): KillRequestRoute {
  const server = new DaemonServer({
    socketPath: 'unused-kill-request-socket',
    tokenPath: 'unused-kill-request-token',
    spawnSubprocess: () => {
      throw new Error('kill routing tests do not spawn subprocesses')
    }
  })
  return server as unknown as KillRequestRoute
}

describe('DaemonServer kill requests', () => {
  it('refuses an auto-intent kill while a live non-shell foreground process runs', async () => {
    const daemon = createKillRequestRoute()
    const foreground = vi.spyOn(daemon.host, 'getForegroundProcess').mockReturnValue('claude')
    const kill = vi.spyOn(daemon.host, 'kill').mockResolvedValue(undefined)

    await expect(
      daemon.routeRequest('client-1', {
        id: 'auto-live',
        type: 'kill',
        payload: { sessionId: 'agent-session', intent: 'auto' }
      })
    ).resolves.toEqual({ refused: true })
    expect(kill).not.toHaveBeenCalled()

    foreground.mockReturnValue('zsh')
    await expect(
      daemon.routeRequest('client-1', {
        id: 'auto-shell',
        type: 'kill',
        payload: { sessionId: 'agent-session', intent: 'auto' }
      })
    ).resolves.toEqual({})
    expect(kill).toHaveBeenCalledWith('agent-session', { immediate: undefined })
  })

  it('keeps a legacy intent-less kill unconditional', async () => {
    const daemon = createKillRequestRoute()
    const foreground = vi.spyOn(daemon.host, 'getForegroundProcess').mockReturnValue('claude')
    const kill = vi.spyOn(daemon.host, 'kill').mockResolvedValue(undefined)

    await expect(
      daemon.routeRequest('client-1', {
        id: 'legacy',
        type: 'kill',
        payload: { sessionId: 'legacy-session' }
      })
    ).resolves.toEqual({})
    expect(foreground).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith('legacy-session', { immediate: undefined })
  })
})
