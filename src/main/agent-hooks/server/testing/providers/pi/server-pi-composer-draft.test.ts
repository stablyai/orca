import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { buildBody, PANE } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Pi composer draft status', () => {
  async function withServer(
    run: (
      post: (payload: Record<string, unknown>) => Promise<void>,
      server: AgentHookServer
    ) => Promise<void>
  ) {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const post = async (payload: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/pi`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody(payload, { launchToken: 'pi-draft-token' }))
      })
      expect(response.ok).toBe(true)
    }
    try {
      await run(post, server)
    } finally {
      server.stop()
    }
  }

  it('keeps the reported draft on the row and restates it without changing state', async () => {
    await withServer(async (post, server) => {
      await post({ hook_event_name: 'agent_end', composer_draft: false })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done', composerDraft: false })
      ])

      await post({ hook_event_name: 'composer_draft', composer_draft: true })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done', composerDraft: true })
      ])

      // A later lifecycle post carries the extension's current reading.
      await post({ hook_event_name: 'before_agent_start', prompt: 'next', composer_draft: false })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'working', composerDraft: false })
      ])
    })
  })

  it('leaves the draft unreported for an older extension and ignores a draft post with no row', async () => {
    await withServer(async (post, server) => {
      await post({ hook_event_name: 'composer_draft', composer_draft: true })
      expect(server.getStatusSnapshot()).toEqual([])

      await post({ hook_event_name: 'agent_end' })
      const [row] = server.getStatusSnapshot()
      expect(row).toMatchObject({ paneKey: PANE, state: 'done' })
      expect(row).not.toHaveProperty('composerDraft')
    })
  })
})
