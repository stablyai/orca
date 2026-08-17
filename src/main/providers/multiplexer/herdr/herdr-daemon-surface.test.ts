import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: the remaining protocol-19 server/client surface — server lifecycle,
// notifications, popup, window title, the plugin registry, integrations, and
// pane graphics flags. The in-app daemon owns its own lifecycle, so live_handoff
// and stop report no-ops; the rest are lightweight registries.
describe('herdr daemon protocol-19 server/client surface', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-surface-test-'))
    socketPath = join(dir, 'herdr.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    server = new HerdrTransport(socketPath)
    daemon = new HerdrDaemon(server)
    await server.startServer()
  }

  async function roundTrip<T>(method: string, params: unknown): Promise<T> {
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      return (await client.request(method, params)) as T
    } finally {
      await client.close()
    }
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('reports live_handoff as already_live and rejects protocol mismatch', async () => {
    await setup()
    const ok = await roundTrip<{ handed_off: boolean; reason: string }>('server.live_handoff', {})
    expect(ok.handed_off).toBe(false)
    expect(ok.reason).toBe('already_live')

    const mismatch = await roundTrip<{ reason: string }>('server.live_handoff', {
      expected_protocol: 1
    })
    expect(mismatch.reason).toBe('protocol_mismatch')
  })

  it('refuses server.stop and reloads config', async () => {
    await setup()
    const stopped = await roundTrip<{ stopped: boolean }>('server.stop', {})
    expect(stopped.stopped).toBe(false)

    const reloaded = await roundTrip<{ reloaded: boolean }>('server.reload_config', {})
    expect(reloaded.reloaded).toBe(true)
  })

  it('shows a notification and closes a popup', async () => {
    await setup()
    const shown = await roundTrip<{ shown: boolean; reason: string; title: string }>(
      'notification.show',
      { title: 'Agent blocked', body: 'codex is blocked', position: 'bottom-right' }
    )
    expect(shown.shown).toBe(true)
    expect(shown.reason).toBe('shown')
    expect(shown.title).toBe('Agent blocked')

    const closed = await roundTrip<{ closed: boolean }>('popup.close', { id: 'p1' })
    expect(closed.closed).toBe(true)
  })

  it('sets and clears the client window title', async () => {
    await setup()
    const set = await roundTrip<{ set: boolean; title: string }>('client.window_title.set', {
      title: 'orca — proj'
    })
    expect(set.set).toBe(true)
    expect(set.title).toBe('orca — proj')

    const cleared = await roundTrip<{ cleared: boolean }>('client.window_title.clear', {})
    expect(cleared.cleared).toBe(true)
  })

  it('links, lists, enables, disables, and unlinks a plugin', async () => {
    await setup()
    const linked = await roundTrip<{ linked: boolean; name: string }>('plugin.link', {
      name: 'my-plugin',
      path: '/plugins/my-plugin'
    })
    expect(linked.linked).toBe(true)

    const list = await roundTrip<{ plugins: { name: string; enabled: boolean }[] }>(
      'plugin.list',
      {}
    )
    expect(list.plugins.map((p) => p.name)).toContain('my-plugin')
    expect(list.plugins[0].enabled).toBe(true)

    const disabled = await roundTrip<{ disabled: boolean }>('plugin.disable', {
      name: 'my-plugin'
    })
    expect(disabled.disabled).toBe(true)

    const enabled = await roundTrip<{ enabled: boolean }>('plugin.enable', {
      name: 'my-plugin'
    })
    expect(enabled.enabled).toBe(true)

    const unlinked = await roundTrip<{ unlinked: boolean }>('plugin.unlink', {
      name: 'my-plugin'
    })
    expect(unlinked.unlinked).toBe(true)
  })

  it('lists actions, invokes one, and reads plugin logs', async () => {
    await setup()
    await roundTrip('plugin.link', { name: 'log-plugin' })

    const actions = await roundTrip<{ actions: string[] }>('plugin.action.list', {
      name: 'log-plugin'
    })
    expect(actions.actions).toEqual([])

    const invoked = await roundTrip<{ invoked: boolean; action: string }>('plugin.action.invoke', {
      name: 'log-plugin',
      action: 'run'
    })
    expect(invoked.invoked).toBe(true)
    expect(invoked.action).toBe('run')

    const logs = await roundTrip<{ logs: { name: string; message: string }[] }>('plugin.log.list', {
      name: 'log-plugin'
    })
    expect(logs.logs.length).toBeGreaterThan(0)
    expect(logs.logs.some((l) => l.message.includes('invoked'))).toBe(true)
  })

  it('opens, focuses, and closes a plugin pane', async () => {
    await setup()
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    const paneId = applied.layout.panes[0].pane_id

    const opened = await roundTrip<{ tab_id: string }>('plugin.pane.open', { label: 'plugin' })
    expect(opened.tab_id).toBeTruthy()

    const focused = await roundTrip<{ pane_id: string }>('plugin.pane.focus', {
      pane_id: paneId
    })
    expect(focused.pane_id).toBe(paneId)

    const closed = await roundTrip<{ closed: boolean }>('plugin.pane.close', {
      pane_id: paneId
    })
    expect(closed.closed).toBe(true)
  })

  it('installs and uninstalls an integration', async () => {
    await setup()
    const installed = await roundTrip<{ installed: boolean }>('integration.install', {
      name: 'gh'
    })
    expect(installed.installed).toBe(true)

    const uninstalled = await roundTrip<{ uninstalled: boolean }>('integration.uninstall', {
      name: 'gh'
    })
    expect(uninstalled.uninstalled).toBe(true)
  })

  it('sets, clears, and queries pane graphics', async () => {
    await setup()
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    const paneId = applied.layout.panes[0].pane_id

    const set = await roundTrip<{ set: boolean; protocol: string | null }>('pane.graphics.set', {
      pane_id: paneId,
      protocol: 'sixel'
    })
    expect(set.set).toBe(true)
    expect(set.protocol).toBe('sixel')

    const info = await roundTrip<{ supported: boolean }>('pane.graphics.info', {
      pane_id: paneId
    })
    expect(info.supported).toBe(false)

    const cleared = await roundTrip<{ cleared: boolean }>('pane.graphics.clear', {
      pane_id: paneId
    })
    expect(cleared.cleared).toBe(true)
  })

  it('rejects plugin.enable for an unknown plugin', async () => {
    await setup()
    await expect(roundTrip('plugin.enable', { name: 'nope' })).rejects.toMatchObject({
      code: 'plugin_not_found'
    })
  })
})
