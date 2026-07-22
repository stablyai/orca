import { describe, expect, it, vi } from 'vitest'
import { DaemonServer } from './daemon-server'
import type { DaemonRequest } from './types'
import type { SubprocessHandle } from './session'

// Why: routeRequest is private; this seam mirrors the kill path's attribution fields.
type DaemonServerPrivate = {
  host: { kill: (sessionId: string, opts?: { immediate?: boolean }) => void | Promise<void> }
  routeRequest(clientId: string, request: DaemonRequest): Promise<unknown>
}

describe('DaemonServer kill attribution', () => {
  it('logs the requesting clientId and requestId on session-killed', async () => {
    const logged: { event: string; details?: Record<string, unknown> }[] = []
    const server = new DaemonServer({
      socketPath: '/tmp/kill-attribution.sock',
      tokenPath: '/tmp/kill-attribution.token',
      // Why: the kill path never spawns; host.kill is mocked, so no session is created.
      spawnSubprocess: () => ({}) as unknown as SubprocessHandle,
      log: {
        log: (event, details) => logged.push({ event, details }),
        close: () => {}
      }
    })
    const daemon = server as unknown as DaemonServerPrivate
    vi.spyOn(daemon.host, 'kill').mockResolvedValue(undefined)

    await daemon.routeRequest('client-42', {
      id: 'kill-req-7',
      type: 'kill',
      payload: { sessionId: 'agent-session', immediate: true }
    })

    const killed = logged.find((entry) => entry.event === 'session-killed')
    expect(killed?.details).toMatchObject({
      sessionId: 'agent-session',
      immediate: true,
      clientId: 'client-42',
      requestId: 'kill-req-7'
    })
  })
})
