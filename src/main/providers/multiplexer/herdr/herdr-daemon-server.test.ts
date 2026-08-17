import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { HERDR_PROTOCOL_VERSION } from './herdr-daemon-schema'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: real socket round-trips against the in-app daemon, proving the wire envelope
// ({id, result|error}) and the protocol-19 structural surface end to end. HOME is
// redirected so getHerdrDataDir() stays out of the real profile.
describe('herdr daemon protocol-19 server', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-daemon-test-'))
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

  it('answers ping over the wire', async () => {
    await setup()
    await expect(roundTrip('ping', {})).resolves.toEqual({ ok: true })
  })

  it('serves the protocol-19 schema over the wire', async () => {
    await setup()
    const schema = await roundTrip<{ protocol: number; schema_version: number }>('api.schema', {})
    expect(schema.protocol).toBe(HERDR_PROTOCOL_VERSION)
    expect(schema.schema_version).toBe(1)
  })

  it('serves an empty session.snapshot with the protocol field', async () => {
    await setup()
    const result = await roundTrip<{
      snapshot: { protocol: number; workspaces: unknown[] }
    }>('session.snapshot', {})
    expect(result.snapshot.protocol).toBe(HERDR_PROTOCOL_VERSION)
    expect(result.snapshot.workspaces).toEqual([])
  })

  it('creates workspaces and tabs structurally', async () => {
    await setup()
    await roundTrip('workspace.create', { label: 'my-project' })
    const workspaces = await roundTrip<{ workspaces: { workspace_id: string }[] }>(
      'workspace.list',
      {}
    )
    expect(workspaces.workspaces).toHaveLength(1)
    const created = await roundTrip<{ tab: { tab_id: string } }>('tab.create', {
      workspace_id: workspaces.workspaces[0].workspace_id,
      label: 'default'
    })
    expect(created.tab.tab_id).toBeTruthy()
    const snapshot = await roundTrip<{ snapshot: { workspaces: unknown[]; tabs: unknown[] } }>(
      'session.snapshot',
      {}
    )
    expect(snapshot.snapshot.workspaces).toHaveLength(1)
    expect(snapshot.snapshot.tabs).toHaveLength(2)
  })

  it('returns a protocol-19 error envelope for unknown panes', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      await expect(client.request('pane.close', { pane_id: 'p99' })).rejects.toThrow(
        'Pane p99 not found'
      )
    } finally {
      await client.close()
    }
  })

  it('rejects layout.export when no tab exists', async () => {
    await setup()
    await expect(roundTrip('layout.export', {})).rejects.toThrow('No tab to export')
  })

  it('round-trips pane I/O over a real PTY: send_text, wait_for_output, read', async () => {
    await setup()
    const applied = await roundTrip<{
      layout: { panes: { pane_id: string }[] }
      tab_id: string
      workspace_id: string
    }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_label: 'proj',
      tab_label: 'default'
    })
    const paneId = applied.layout.panes[0].pane_id
    try {
      await roundTrip('pane.send_text', { pane_id: paneId, text: 'echo herdr-roundtrip-42\r' })
      const waited = await roundTrip<{
        pane_id: string
        matched_line: string | null
        revision: number
      }>('pane.wait_for_output', {
        pane_id: paneId,
        match: { type: 'substring', value: 'herdr-roundtrip-42' },
        timeout_ms: 5000
      })
      expect(waited.pane_id).toBe(paneId)
      expect(waited.revision).toBeGreaterThan(0)
      expect(waited.matched_line).toContain('herdr-roundtrip-42')

      const read = await roundTrip<{ read: { text: string; source: string; revision: number } }>(
        'pane.read',
        { pane_id: paneId, source: 'recent', lines: 50, format: 'text' }
      )
      expect(read.read.text).toContain('herdr-roundtrip-42')
      expect(read.read.source).toBe('recent')
      expect(read.read.revision).toBe(waited.revision)
    } finally {
      await roundTrip('pane.close', { pane_id: paneId }).catch(() => undefined)
    }
  })

  it('renames, zooms, and reports agents on a PTY-backed pane', async () => {
    await setup()
    const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_label: 'proj',
      tab_label: 'default'
    })
    const paneId = applied.layout.panes[0].pane_id
    try {
      const renamed = await roundTrip('pane.rename', { pane_id: paneId, label: 'editor' })
      expect(renamed).toMatchObject({ pane_id: paneId, label: 'editor' })

      const layout = await roundTrip<{ layout: { tab_id: string; panes: unknown[] } }>(
        'pane.layout',
        { pane_id: paneId }
      )
      expect(layout.layout.panes).toHaveLength(1)

      const zoomed = await roundTrip<{ zoomed: boolean; layout: { zoomed: boolean } }>(
        'pane.zoom',
        { pane_id: paneId }
      )
      expect(zoomed.zoomed).toBe(true)
      expect(zoomed.layout.zoomed).toBe(true)

      const reported = await roundTrip<{ agent: string; agent_status: string }>(
        'pane.report_agent',
        { pane_id: paneId, agent: 'codex' }
      )
      expect(reported).toMatchObject({ agent: 'codex', agent_status: 'working' })

      const released = await roundTrip<{ agent: null; agent_status: string }>(
        'pane.release_agent',
        { pane_id: paneId }
      )
      expect(released.agent).toBeNull()
      expect(released.agent_status).toBe('idle')

      const snapshot = await roundTrip<{
        snapshot: { panes: { label?: string; agent: string | null }[] }
      }>('session.snapshot', {})
      expect(snapshot.snapshot.panes[0].label).toBe('editor')
      expect(snapshot.snapshot.panes[0].agent).toBeNull()
    } finally {
      await roundTrip('pane.close', { pane_id: paneId }).catch(() => undefined)
    }
  })
})
