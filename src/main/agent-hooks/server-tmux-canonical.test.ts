import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { postHookEvent } from './server.test-fixtures'
import {
  TMUX_TEST_PANE,
  TMUX_TEST_ROOT,
  TMUX_TEST_ROWS,
  tmuxTestBody
} from '../../shared/tmux-status.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn())
vi.mock('../../shared/tmux-host-attachment-probe', () => ({ probeTmuxHostAttachments: probe }))
class CanonicalTestServer extends AgentHookServer {
  hasLegacyRow(): boolean {
    return this.state.lastStatusByPaneKey.has(TMUX_TEST_PANE)
  }
}
let server: CanonicalTestServer
beforeEach(async () => {
  _internals.resetCachesForTests()
  probe.mockResolvedValue({ clients: [{ pid: 101, pane: '%0' }], rows: TMUX_TEST_ROWS })
  server = new CanonicalTestServer()
  server.setTmuxManagedPtyResolver(async () => TMUX_TEST_ROOT)
  await server.start({ env: 'production' })
})
afterEach(() => server.stop())
describe('main canonical tmux projection', () => {
  it('publishes one canonical outer row, blocks legacy overwrites, and cleans the exact outer and inner subjects', async () => {
    expect((await postHookEvent(server, tmuxTestBody(), '/hook/opencode')).status).toBe(204)
    expect(server.hasLegacyRow()).toBe(false)
    expect(
      server.attestCompatibilityAuthority({
        paneKey: TMUX_TEST_PANE,
        launchTokenHash: createHash('sha256').update('generation').digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).toEqual({ paneKey: TMUX_TEST_PANE, source: 'current_hook' })
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(2)
    expect(server.getStatusSnapshot()).toMatchObject([{ paneKey: TMUX_TEST_PANE, state: 'done' }])
    server.ingestTerminalStatus({
      paneKey: TMUX_TEST_PANE,
      worktreeId: 'workspace',
      payload: { state: 'working', prompt: 'untrusted repaint', agentType: 'opencode' }
    })
    expect(server.hasLegacyRow()).toBe(false)
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
    server.clearPaneState(TMUX_TEST_PANE)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(0)
    expect(server.getStatusSnapshot()).toHaveLength(0)
  })
  it('removes canonical tmux status on certified retirement', async () => {
    await postHookEvent(server, tmuxTestBody(), '/hook/opencode')
    server.retirePaneAuthority(TMUX_TEST_PANE)
    expect(server.getStatusSnapshot()).toHaveLength(0)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(0)
  })
  it('dismisses a canonical projection without creating a legacy status copy', async () => {
    await postHookEvent(server, tmuxTestBody(), '/hook/opencode')
    server.dropStatusEntry(TMUX_TEST_PANE, { preserveResumeIdentity: false })
    expect(server.hasLegacyRow()).toBe(false)
    expect(server.getStatusSnapshot()).toHaveLength(0)
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(2)
    server.dropStatusEntriesByTabPrefix('tab-tmux')
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(0)
  })
})
