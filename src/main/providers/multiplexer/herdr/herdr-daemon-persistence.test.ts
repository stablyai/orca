import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { getSessionStatePath } from './herdr-daemon-persistence'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: soft reattach. The daemon persists the session model + pane buffers to
// the data dir and reloads them on boot so quit+reopen restores the layout and
// prior output. Running processes are NOT resumed; fresh shells start in the
// saved cwds with the saved scrollback prepended to the buffer.
describe('herdr daemon persistence + reattach', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let homeDir: string | null = null
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setupDaemon(): Promise<void> {
    homeDir = mkdtempSync(join(tmpdir(), 'herdr-persist-'))
    process.env.HOME = homeDir
    setHerdrTestDataDir(homeDir)
    socketPath = join(homeDir, 'herdr.sock')
    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
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
    homeDir = null
  })

  it('persists the session model + pane buffers to the data dir', async () => {
    await setupDaemon()
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    const paneId = applied.layout.panes[0].pane_id

    // Write some output so the buffer is non-empty, then force the debounced
    // save by waiting past the 1s window.
    await roundTrip('pane.send_text', { pane_id: paneId, text: 'echo hello\r' })
    await new Promise((resolve) => setTimeout(resolve, 1300))

    expect(existsSync(getSessionStatePath('orca'))).toBe(true)
    const state = JSON.parse(readFileSync(getSessionStatePath('orca'), 'utf8'))
    expect(state.workspaces[0].label).toBe('proj')
    expect(state.panes.length).toBe(2)
    expect(state.panes.some((pane: { pane_id: string }) => pane.pane_id === paneId)).toBe(true)
  })

  it('restores the layout on a second daemon boot', async () => {
    await setupDaemon()
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    await roundTrip('layout.apply', {
      root: {
        type: 'split',
        direction: 'right',
        ratio: 0.5,
        first: { type: 'pane', pane_id: 'a' },
        second: { type: 'pane', pane_id: 'b' }
      },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    await new Promise((resolve) => setTimeout(resolve, 1300))

    // Stop the first daemon and start a fresh one on the same data dir.
    await daemon?.dispose()
    daemon = null
    await server!.close()
    server = null

    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    daemon = new HerdrDaemon(server)
    await server.startServer()

    const snapshot = await roundTrip<{
      snapshot: { workspaces: { label: string }[]; panes: { pane_id: string }[] }
    }>('session.snapshot', {})
    expect(snapshot.snapshot.workspaces[0].label).toBe('proj')
    expect(snapshot.snapshot.panes.length).toBe(3)
  })

  it('starts fresh when no saved state exists', async () => {
    await setupDaemon()
    const snapshot = await roundTrip<{ snapshot: { workspaces: unknown[]; panes: unknown[] } }>(
      'session.snapshot',
      {}
    )
    expect(snapshot.snapshot.workspaces).toHaveLength(0)
    expect(snapshot.snapshot.panes).toHaveLength(0)
  })

  it('ignores saved state from a mismatched protocol version', async () => {
    await setupDaemon()
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    await roundTrip('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    await new Promise((resolve) => setTimeout(resolve, 1300))
    await daemon?.dispose()
    daemon = null
    await server!.close()
    server = null

    // Corrupt the protocol version in the saved state.
    const statePath = getSessionStatePath('orca')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.protocol = 999
    require('node:fs').writeFileSync(statePath, JSON.stringify(state))

    server = new HerdrTransport(socketPath)
    server.on('error', () => {})
    daemon = new HerdrDaemon(server)
    await server.startServer()

    const snapshot = await roundTrip<{ snapshot: { workspaces: unknown[] } }>(
      'session.snapshot',
      {}
    )
    expect(snapshot.snapshot.workspaces).toHaveLength(0)
  })
})
