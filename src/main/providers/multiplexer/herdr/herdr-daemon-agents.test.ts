import { afterEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

// Why: the agent module serves list/get/wait/read/rename/focus/explain/start/
// prompt/send_keys plus agent.view.* and server.agent_manifests. Agents are
// panes with an attached identity; target resolves by pane id or agent name.
describe('herdr daemon protocol-19 agents', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-agent-test-'))
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

  async function makeAgentPane(): Promise<{ pane_id: string; agent: string }> {
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    const paneId = applied.layout.panes[0].pane_id
    await roundTrip('pane.report_agent', { pane_id: paneId, agent: 'codex' })
    return { pane_id: paneId, agent: 'codex' }
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
  })

  it('lists agents and gets one by pane id and by name', async () => {
    await setup()
    const { pane_id, agent } = await makeAgentPane()

    const list = await roundTrip<{ agents: { agent: string; pane_id: string }[] }>('agent.list', {})
    const entry = list.agents.find((candidate) => candidate.pane_id === pane_id)
    expect(entry).toBeDefined()
    expect(entry!.agent).toBe(agent)

    const byId = await roundTrip<{ agent: string; pane_id: string }>('agent.get', {
      target: pane_id
    })
    expect(byId.agent).toBe(agent)

    const byName = await roundTrip<{ agent: string; pane_id: string }>('agent.get', {
      target: agent
    })
    expect(byName.pane_id).toBe(pane_id)
  })

  it('renames and focuses an agent', async () => {
    await setup()
    const { pane_id } = await makeAgentPane()

    const renamed = await roundTrip<{ name: string }>('agent.rename', {
      target: pane_id,
      name: 'my-codex'
    })
    expect(renamed.name).toBe('my-codex')

    const focused = await roundTrip<{ pane_id: string }>('agent.focus', { target: pane_id })
    expect(focused.pane_id).toBe(pane_id)
  })

  it('explains an agent with its manifest', async () => {
    await setup()
    const { pane_id, agent } = await makeAgentPane()

    const explained = await roundTrip<{
      agent: string
      final_state: string
      manifest?: { source: string; version: string }
    }>('agent.explain', { target: pane_id })
    expect(explained.agent).toBe(agent)
    expect(explained.manifest?.source).toBe('builtin')
  })

  it('explains a pane with no agent and reports a skip reason', async () => {
    await setup()
    const ws = await roundTrip<{ workspace: { workspace_id: string } }>('workspace.create', {
      label: 'proj'
    })
    const applied = await roundTrip<{ layout: { panes: { pane_id: string }[] } }>('layout.apply', {
      root: { type: 'pane', pane_id: 'a' },
      workspace_id: ws.workspace.workspace_id,
      tab_label: 'default'
    })
    const explained = await roundTrip<{ agent: null; skip_reason?: string }>('agent.explain', {
      target: applied.layout.panes[0].pane_id
    })
    expect(explained.agent).toBeNull()
    expect(explained.skip_reason).toBe('no_agent')
  })

  it('starts an agent in a pane and reads its buffer', async () => {
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

    const started = await roundTrip<{ pane_id: string; agent: string }>('agent.start', {
      name: 'claude',
      kind: 'cli',
      pane_id: paneId
    })
    expect(started.agent).toBe('claude')

    const got = await roundTrip<{ agent: string }>('agent.get', { target: paneId })
    expect(got.agent).toBe('claude')

    const read = await roundTrip<{ read: { text: string; revision: number } }>('agent.read', {
      target: paneId,
      source: 'recent',
      lines: 50
    })
    expect(typeof read.read.text).toBe('string')
    expect(read.read.revision).toBeGreaterThanOrEqual(0)
  })

  it('prompts an agent and sends keys', async () => {
    await setup()
    const { pane_id } = await makeAgentPane()

    const prompted = await roundTrip<{ pane_id: string; sequence: number }>('agent.prompt', {
      target: pane_id,
      text: 'hello',
      wait: false
    })
    expect(prompted.pane_id).toBe(pane_id)

    const sent = await roundTrip<{ pane_id: string; sequence: number }>('agent.send_keys', {
      target: pane_id,
      keys: ['\r']
    })
    expect(sent.pane_id).toBe(pane_id)
  })

  it('waits for an agent status with a timeout', async () => {
    await setup()
    const { pane_id } = await makeAgentPane()
    const result = await roundTrip<{ agent: { agent_status: string } }>('agent.wait', {
      target: pane_id,
      until: ['done'],
      timeout_ms: 100
    })
    // Why: status stays 'working' (set by report_agent) so the wait times out
    // and returns the current state instead of throwing.
    expect(result.agent.agent_status).toBe('working')
  })

  it('serves and reloads agent manifests', async () => {
    await setup()
    const manifests = await roundTrip<{ manifests: { name: string }[] }>(
      'server.agent_manifests',
      {}
    )
    expect(manifests.manifests.map((m) => m.name)).toContain('codex')
    expect(manifests.manifests.map((m) => m.name)).toContain('claude')

    const reloaded = await roundTrip<{ reloaded: boolean; count: number }>(
      'server.reload_agent_manifests',
      {}
    )
    expect(reloaded.reloaded).toBe(true)
    expect(reloaded.count).toBe(manifests.manifests.length)
  })

  it('sets and clears an agent view', async () => {
    await setup()
    const set = await roundTrip<{ source: string; label: string | null }>('agent.view.set', {
      source: 'orca',
      label: 'all'
    })
    expect(set.source).toBe('orca')

    const cleared = await roundTrip<{ cleared: boolean }>('agent.view.clear', {
      source: 'orca'
    })
    expect(cleared.cleared).toBe(true)
  })

  it('rejects agent.get for an unknown target', async () => {
    await setup()
    await expect(roundTrip('agent.get', { target: 'nope' })).rejects.toMatchObject({
      code: 'agent_not_found'
    })
  })

  it('auto-detects an agent from the PTY buffer', async () => {
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

    // Why: send enough chunks containing the agent signature for the throttled
    // detector (every 10th chunk) to fire.
    for (let i = 0; i < 15; i++) {
      await roundTrip('pane.send_text', { pane_id: paneId, text: 'codex working\r' })
    }

    await new Promise<void>((resolve) => {
      const tick = (): void => {
        setTimeout(() => {
          void roundTrip<{ agent: string | null }>('agent.get', { target: paneId }).then((got) => {
            if (got.agent === 'codex') {
              resolve()
            } else {
              tick()
            }
          })
        }, 50)
      }
      tick()
    })

    const got = await roundTrip<{ agent: string | null }>('agent.get', { target: paneId })
    expect(got.agent).toBe('codex')
  })
})
