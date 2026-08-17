import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: the events contract the daemon serves — events.subscribe keeps the
// connection open and pushes {event, data:{type,...}} frames filtered by kind,
// and events.wait long-polls the in-process event bus.
describe('herdr daemon protocol-19 events', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-events-test-'))
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

  function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        if (condition()) {
          resolve()
          return
        }
        if (Date.now() > deadline) {
          reject(new Error('timed out waiting for condition'))
          return
        }
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('subscribes and keeps the connection open', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const result = await client.request('events.subscribe', {
        subscriptions: [{ type: 'workspace.created' }]
      })
      expect(result).toEqual({ type: 'subscription_started' })
    } finally {
      await client.close()
    }
  })

  it('pushes {event, data} frames for subscribed kinds', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const events: unknown[] = []
      client.on('event', (event) => events.push(event))
      await client.request('events.subscribe', {
        subscriptions: [{ type: 'workspace.created' }]
      })

      await roundTrip('workspace.create', { label: 'proj' })

      await pollUntil(() => events.length >= 1)
      const frame = events[0] as {
        event: string
        data: { type: string; workspace_id: string; label: string }
      }
      expect(frame.event).toBe('workspace.created')
      expect(frame.data.type).toBe('workspace.created')
      expect(frame.data.label).toBe('proj')
      expect(typeof frame.data.workspace_id).toBe('string')
    } finally {
      await client.close()
    }
  })

  it('does not deliver events outside the subscribed kinds', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const events: unknown[] = []
      client.on('event', (event) => events.push(event))
      await client.request('events.subscribe', {
        subscriptions: [{ type: 'workspace.created' }]
      })

      await roundTrip('workspace.create', { label: 'proj' })
      await pollUntil(() => events.length >= 1)

      await roundTrip('layout.apply', {
        root: { type: 'pane', pane_id: 'a' },
        workspace_label: 'proj',
        tab_label: 'default'
      })

      const before = events.length
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(events.length).toBe(before)
    } finally {
      await client.close()
    }
  })

  it('emits pane lifecycle and layout events on layout.apply', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const events: string[] = []
      client.on('event', (frame: { event: string }) => events.push(frame.event))
      await client.request('events.subscribe', {
        subscriptions: [
          { type: 'workspace.created' },
          { type: 'pane.created' },
          { type: 'pane.closed' },
          { type: 'layout.updated' }
        ]
      })

      await roundTrip('workspace.create', { label: 'proj' })
      const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>(
        'layout.apply',
        {
          root: { type: 'pane', pane_id: 'a' },
          workspace_label: 'proj',
          tab_label: 'default'
        }
      )
      const paneId = applied.layout.panes[0].pane_id

      await pollUntil(() => events.includes('layout.updated'))
      expect(events).toContain('workspace.created')
      expect(events).toContain('pane.created')

      await roundTrip('pane.close', { pane_id: paneId })
      await pollUntil(() => events.includes('pane.closed'))
      expect(events).toContain('pane.closed')
    } finally {
      await client.close()
    }
  })

  it('events.wait resolves with the matching event', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const waiting = client.request('events.wait', {
        match: { type: 'workspace.created' },
        timeout_ms: 2000
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await roundTrip('workspace.create', { label: 'proj' })

      const event = await waiting
      expect(event).toMatchObject({ type: 'workspace.created', label: 'proj' })
    } finally {
      await client.close()
    }
  })

  it('events.wait resolves null when nothing matches before the timeout', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const event = await client.request('events.wait', {
        match: { type: 'workspace.created' },
        timeout_ms: 150
      })
      expect(event).toBeNull()
    } finally {
      await client.close()
    }
  })

  it('rejects events.subscribe with an unknown event kind', async () => {
    await setup()
    await expect(
      roundTrip('events.subscribe', { subscriptions: [{ type: 'pane.nope' }] })
    ).rejects.toMatchObject({ code: 'unknown_event_type' })
  })

  it('emits pane.agent_status_changed on report and release', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const events: string[] = []
      client.on('event', (frame: { event: string }) => events.push(frame.event))
      await client.request('events.subscribe', {
        subscriptions: [{ type: 'pane.agent_status_changed' }]
      })

      const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
        label: 'proj'
      })
      const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>(
        'layout.apply',
        {
          root: { type: 'pane', pane_id: 'a' },
          workspace_id: ws.workspace.workspace_id,
          tab_label: 'default'
        }
      )
      const paneId = applied.layout.panes[0].pane_id

      await roundTrip('pane.report_agent', { pane_id: paneId, agent: 'codex' })
      await pollUntil(() => events.includes('pane.agent_status_changed'))
    } finally {
      await client.close()
    }
  })

  it('emits pane.output_matched when wait_for_output matches', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const events: string[] = []
      client.on('event', (frame: { event: string }) => events.push(frame.event))
      await client.request('events.subscribe', {
        subscriptions: [{ type: 'pane.output_matched' }]
      })

      const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
        label: 'proj'
      })
      const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>(
        'layout.apply',
        {
          root: { type: 'pane', pane_id: 'a' },
          workspace_id: ws.workspace.workspace_id,
          tab_label: 'default'
        }
      )
      const paneId = applied.layout.panes[0].pane_id

      await roundTrip('pane.send_text', { pane_id: paneId, text: 'hello world\r' })
      await roundTrip('pane.wait_for_output', {
        pane_id: paneId,
        match: { type: 'substring', value: 'hello' },
        timeout_ms: 1000
      })
      await pollUntil(() => events.includes('pane.output_matched'))
    } finally {
      await client.close()
    }
  })

  it('emits pane.scroll_changed on resize', async () => {
    await setup()
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      const events: string[] = []
      client.on('event', (frame: { event: string }) => events.push(frame.event))
      await client.request('events.subscribe', {
        subscriptions: [{ type: 'pane.scroll_changed' }]
      })

      const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
        label: 'proj'
      })
      const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>(
        'layout.apply',
        {
          root: { type: 'pane', pane_id: 'a' },
          workspace_id: ws.workspace.workspace_id,
          tab_label: 'default'
        }
      )
      const paneId = applied.layout.panes[0].pane_id

      await roundTrip('pane.resize', { pane_id: paneId, cols: 100, rows: 40 })
      await pollUntil(() => events.includes('pane.scroll_changed'))
    } finally {
      await client.close()
    }
  })
})
