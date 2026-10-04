import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import {
  TMUX_TEST_PANE,
  TMUX_TEST_ROOT,
  TMUX_TEST_ROWS,
  tmuxTestBody
} from '../shared/tmux-status.test-fixture'
const probe = vi.hoisted(() => vi.fn())
vi.mock('../shared/tmux-host-attachment-probe', () => ({ probeTmuxHostAttachments: probe }))
class CanonicalTestServer extends RelayAgentHookServer {
  snapshot() {
    return this.canonicalStatusStore.getSnapshot()
  }
}
let server: CanonicalTestServer
let directory: string
const forward = vi.fn()
const unavailable = vi.fn()
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-tmux-canonical-'))
  forward.mockClear()
  unavailable.mockClear()
  probe.mockResolvedValue({ clients: [{ pid: 101, pane: '%0' }], rows: TMUX_TEST_ROWS })
  server = new CanonicalTestServer({
    endpointDir: directory,
    forward,
    forwardUnavailable: unavailable,
    getTmuxManagedPty: async () => TMUX_TEST_ROOT
  })
  await server.start({ publishEndpoint: false })
})
afterEach(() => {
  server.stop()
  rmSync(directory, { recursive: true, force: true })
})
async function post(body: unknown = tmuxTestBody(), source = 'opencode') {
  const coordinates = server.getCoordinates()
  return fetch(`http://127.0.0.1:${coordinates.port}/hook/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': coordinates.token },
    body: JSON.stringify(body)
  })
}
describe('relay canonical tmux ownership and replay', () => {
  it('keeps inner and selected observations in its owner store and replays only the selected outer row', async () => {
    expect((await post()).status).toBe(204)
    expect(server.snapshot().parents).toHaveLength(2)
    forward.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(1)
    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward.mock.lastCall?.[0]).toMatchObject({
      paneKey: TMUX_TEST_PANE,
      payload: { state: 'done' }
    })
    server.clearPaneState(TMUX_TEST_PANE)
    expect(server.snapshot().parents).toHaveLength(0)
    expect(server.replayCachedPayloadsForPanes()).toBe(0)
  })
  it('replaces a legacy OpenCode 2 row with unavailable and preserves its launch identity', async () => {
    const body = tmuxTestBody()
    const { tmux: _tmux, ...legacy } = body
    expect((await post(legacy, 'opencode2')).status).toBe(204)
    probe.mockResolvedValue({ clients: [], rows: TMUX_TEST_ROWS })
    await post(body, 'opencode2')
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled(), { timeout: 2500 })
    forward.mockClear()
    unavailable.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(1)
    expect(forward).not.toHaveBeenCalled()
    expect(unavailable.mock.lastCall?.[0]).toMatchObject({
      source: 'opencode2',
      tabId: 'tab-tmux',
      launchToken: 'generation',
      statusUnavailable: true
    })
  })
  it('derives first unavailable identity from the same outer inner observation', async () => {
    probe.mockResolvedValue({ clients: [{ pid: 101, pane: '%9' }], rows: TMUX_TEST_ROWS })
    await post(tmuxTestBody(), 'opencode2')
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled(), { timeout: 2500 })
    expect(unavailable.mock.lastCall?.[0]).toMatchObject({
      source: 'opencode2',
      tabId: 'tab-tmux',
      launchToken: 'generation'
    })
  })
  it('retains and replays an unavailable projection when it was emitted without a connected reader', async () => {
    await post()
    probe.mockResolvedValue({ clients: [], rows: TMUX_TEST_ROWS })
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1), { timeout: 2500 })
    expect(server.snapshot().parents).toHaveLength(2)
    expect(server.snapshot().parents.filter((parent) => parent.status)).toHaveLength(1)
    unavailable.mockClear()
    forward.mockClear()
    expect(server.replayCachedPayloadsForPanes()).toBe(1)
    expect(forward).not.toHaveBeenCalled()
    expect(unavailable.mock.lastCall?.[0]).toMatchObject({
      paneKey: TMUX_TEST_PANE,
      worktreeId: 'workspace',
      launchToken: 'generation',
      statusUnavailable: true,
      payload: null
    })
    probe.mockResolvedValue(null)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    unavailable.mockClear()
    server.replayCachedPayloadsForPanes()
    expect(unavailable).toHaveBeenCalledTimes(1)
  })
})
