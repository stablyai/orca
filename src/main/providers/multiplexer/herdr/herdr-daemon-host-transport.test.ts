import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'
import { HerdrDaemonHostTransport } from './herdr-daemon-host-transport'
import { unwrapHerdrResponse } from './herdr-runtime-contract'
import type { HerdrTransportEvent } from './herdr-runtime-contract'

// Why: the daemon host transport is the local routing target when the herdr
// backend is active. It connects to the in-app daemon socket (no binary spawn),
// routes requests, and forwards pushed events to listeners.
describe('herdr daemon host transport', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-host-test-'))
    socketPath = join(dir, 'herdr-daemon.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    daemon = new HerdrDaemon(server)
    await server.startServer()
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('ensureSession connects, pings, and subscribes to events', async () => {
    await setup()
    const transport = new HerdrDaemonHostTransport(socketPath)
    await transport.ensureSession('orca')
    await transport.ensureSession('orca')
    await transport.disconnect()
  })

  it('routes requests to the daemon and returns wrapped responses', async () => {
    await setup()
    const transport = new HerdrDaemonHostTransport(socketPath)
    await transport.ensureSession('orca')

    const response = await transport.request<{ workspace: { workspace_id: string } }>(
      'orca',
      'workspace.create',
      {
        label: 'proj'
      }
    )
    const created = unwrapHerdrResponse(response)
    expect(created.workspace.workspace_id).toBeDefined()

    const errorResponse = await transport.request('orca', 'workspace.get', {
      workspace_id: 'nope'
    })
    expect(errorResponse).toHaveProperty('error')
    if ('error' in errorResponse) {
      expect(errorResponse.error.code).toBe('workspace_not_found')
    }

    await transport.disconnect()
  })

  it('forwards pushed events to onEvent listeners', async () => {
    await setup()
    const transport = new HerdrDaemonHostTransport(socketPath)
    await transport.ensureSession('orca')

    const events: HerdrTransportEvent[] = []
    transport.onEvent((event) => events.push(event))

    await transport.request('orca', 'workspace.create', { label: 'proj' })

    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (events.length > 0) {
          resolve()
          return
        }
        setTimeout(tick, 25)
      }
      tick()
    })

    expect(events.length).toBeGreaterThan(0)
    expect(events[0].event).toBe('workspace.created')
    await transport.disconnect()
  })

  it('controlTerminal creates a controller that routes to the daemon', async () => {
    await setup()
    const transport = new HerdrDaemonHostTransport(socketPath)
    await transport.ensureSession('orca')

    const wsResponse = await transport.request<{ workspace_id: string }>(
      'orca',
      'workspace.create',
      { label: 'proj' }
    )
    const workspaceId = unwrapHerdrResponse(wsResponse).workspace_id

    const appliedResponse = await transport.request<{ layout: { panes: { pane_id: string }[] } }>(
      'orca',
      'layout.apply',
      { root: { type: 'pane', pane_id: 'a' }, workspace_id: workspaceId, tab_label: 'default' }
    )
    const paneId = unwrapHerdrResponse(appliedResponse).layout.panes[0].pane_id

    const controller = transport.controlTerminal('orca', paneId, {
      cols: 80,
      rows: 24
    })
    expect(controller).toBeDefined()
    controller.release()
    await transport.disconnect()
  })
})
