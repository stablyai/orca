import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { DESKTOP_HOST_KIND } from '../shared/desktop-host-protocol'
import { resolveDesktopHostListenConfig } from './desktop-host-config'
import { startDesktopHostServer } from './desktop-host-server'

async function waitForResult(
  socket: WebSocket,
  id: string
): Promise<{ ok: boolean; result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for desktop IPC result')),
      8_000
    )
    socket.on('message', (raw) => {
      const parsed = JSON.parse(String(raw)) as {
        type?: string
        id?: string
        ok?: boolean
        result?: unknown
        error?: { message: string }
      }
      if (parsed.type === 'result' && parsed.id === id) {
        clearTimeout(timer)
        resolve(parsed as { ok: boolean; result?: unknown; error?: { message: string } })
      }
    })
  })
}

describe('desktop host server', () => {
  it('serves host info and a real PTY over localhost IPC', async () => {
    const config = resolveDesktopHostListenConfig({
      ORCA_DESKTOP_HOST_PORT: '6772',
      ORCA_DESKTOP_USER_DATA_DIR: '/tmp/orca-tauri-host-test'
    })
    const host = await startDesktopHostServer(config)
    try {
      const health = await fetch(`${host.info.httpUrl}/desktop/health`)
      expect(health.ok).toBe(true)
      const healthBody = (await health.json()) as { host: string }
      expect(healthBody.host).toBe(DESKTOP_HOST_KIND)

      const infoResponse = await fetch(`${host.info.httpUrl}/desktop/host`)
      const info = (await infoResponse.json()) as { pairing: { endpoint: string }; ipcUrl: string }
      expect(info.pairing.endpoint).toContain('6772')
      expect(info.ipcUrl).toBe(host.info.ipcUrl)

      const socket = new WebSocket(host.info.ipcUrl)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', reject)
      })

      const command = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
      socket.send(
        JSON.stringify({
          type: 'invoke',
          id: 'spawn-1',
          channel: 'pty:spawn',
          args: { cols: 80, rows: 24, command }
        })
      )
      const spawned = await waitForResult(socket, 'spawn-1')
      expect(spawned.ok).toBe(true)
      const ptyId = (spawned.result as { id: string }).id
      expect(ptyId).toMatch(/[0-9a-f-]{36}/)

      socket.send(
        JSON.stringify({
          type: 'invoke',
          id: 'kill-1',
          channel: 'pty:kill',
          args: { id: ptyId }
        })
      )
      const killed = await waitForResult(socket, 'kill-1')
      expect(killed.ok).toBe(true)
      socket.close()
    } finally {
      await host.close()
    }
  })
})
