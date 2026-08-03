import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import type { DaemonRequest } from './types'

type DaemonServerPrivate = {
  host: { kill: (sessionId: string, opts?: { immediate?: boolean }) => void | Promise<void> }
  routeRequest(clientId: string, request: DaemonRequest): Promise<unknown>
}

describe('daemon kill attribution', () => {
  let server: DaemonServer
  let dir: string

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records the requesting control client in the session-killed log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-kill-attribution-'))
    const killLog = { log: vi.fn(), close: vi.fn() }
    server = new DaemonServer({
      socketPath: join(dir, 'daemon.sock'),
      tokenPath: join(dir, 'daemon.token'),
      log: killLog,
      spawnSubprocess: () => {
        throw new Error('not used')
      }
    })
    const daemon = server as unknown as DaemonServerPrivate
    vi.spyOn(daemon.host, 'kill').mockImplementation(async () => {
      expect(killLog.log).not.toHaveBeenCalledWith('session-killed', expect.anything())
    })

    await daemon.routeRequest('control-42', {
      id: 'kill-1',
      type: 'kill',
      payload: { sessionId: 'agent-session', immediate: true }
    })

    expect(killLog.log).toHaveBeenCalledWith('session-killed', {
      sessionId: 'agent-session',
      immediate: true,
      clientId: 'control-42'
    })
  })

  it('attributes a failed kill without claiming the session was killed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-kill-attribution-'))
    const killLog = { log: vi.fn(), close: vi.fn() }
    server = new DaemonServer({
      socketPath: join(dir, 'daemon.sock'),
      tokenPath: join(dir, 'daemon.token'),
      log: killLog,
      spawnSubprocess: () => {
        throw new Error('not used')
      }
    })
    const daemon = server as unknown as DaemonServerPrivate
    vi.spyOn(daemon.host, 'kill').mockRejectedValue(new Error('kill refused'))

    await expect(
      daemon.routeRequest('control-42', {
        id: 'kill-1',
        type: 'kill',
        payload: { sessionId: 'agent-session', immediate: true }
      })
    ).rejects.toThrow('kill refused')

    expect(killLog.log).toHaveBeenCalledWith('session-kill-failed', {
      sessionId: 'agent-session',
      immediate: true,
      clientId: 'control-42'
    })
    expect(killLog.log).not.toHaveBeenCalledWith('session-killed', expect.anything())
  })
})
