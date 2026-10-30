import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { postHookEvent, installTestLaunchAuthority } from './server.test-fixtures'
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
  get measuredStore() {
    return this.canonicalStatusStore
  }
  get measuredSubscribers() {
    return {
      status: this.statusChangeListeners.size,
      provider: this.providerSessionChangeListeners.size
    }
  }
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
afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
})
describe('main canonical tmux projection', () => {
  it.each([false, true])(
    'publishes one canonical outer row with delayed verifier=%s, blocks legacy overwrites, and cleans the exact outer and inner subjects',
    async (delayed) => {
      const admit = () =>
        installTestLaunchAuthority(server, [
          { paneKey: TMUX_TEST_PANE, token: 'generation', connectionId: null }
        ])
      if (!delayed) {
        admit()
      }
      expect((await postHookEvent(server, tmuxTestBody(), '/hook/opencode')).status).toBe(204)
      expect(server.hasLegacyRow()).toBe(false)
      if (delayed) {
        expect(server.getCurrentAuthorityObservations()).toHaveLength(0)
        admit()
      }
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
    }
  )
  it.each([10, 100])(
    'captures canonical retirement before delayed credential admission without replacing its subject (C=%s)',
    async (size) => {
      for (let i = 0; i < size; i++) {
        const subject = makeStructuredAgentStatusSubject(
          { ...TMUX_TEST_ROOT.scope, workspaceId: 'foreign' },
          `unrelated-${i}`
        )
        server.ingestStructuredStatus(
          {
            sessionId: subject.sessionId,
            workspaceId: 'foreign',
            agent: 'codex',
            status: 'working',
            hostExecutionOwned: true,
            updatedAt: 100
          },
          subject
        )
      }
      const counts = {
        producerLists: 0,
        producerCopies: 0,
        captureLists: 0,
        callbackLists: 0,
        otherLists: 0,
        otherCopies: 0,
        producerKeyed: 0
      }
      const otherSources: Record<string, { calls: number; copied: number }> = {}
      let phase = 'producer'
      const parents = server.measuredStore.getParents.bind(server.measuredStore)
      vi.spyOn(server.measuredStore, 'getParents').mockImplementation(() => {
        const rows = parents()
        const caller =
          new Error('authority operation caller').stack
            ?.split('\n')
            .find(
              (line) =>
                (line.includes('/src/main/') || line.includes('/src/shared/')) &&
                !line.includes('.test.ts')
            ) ?? ''
        if (caller.includes('server-tmux-status.ts')) {
          counts.producerLists++
          counts.producerCopies += rows.length
        } else if (caller.includes('server-authority-fences.ts')) {
          if (phase === 'capture') {
            counts.captureLists++
          } else {
            counts.callbackLists++
          }
        } else {
          counts.otherLists++
          counts.otherCopies += rows.length
          const entry = (otherSources[caller.trim()] ??= { calls: 0, copied: 0 })
          entry.calls++
          entry.copied += rows.length
        }
        return rows
      })
      const keyed = server.measuredStore.getCanonicalParent.bind(server.measuredStore)
      vi.spyOn(server.measuredStore, 'getCanonicalParent').mockImplementation((subject) => {
        if (
          new Error('authority operation caller').stack
            ?.split('\n')
            .find(
              (line) =>
                (line.includes('/src/main/') || line.includes('/src/shared/')) &&
                !line.includes('.test.ts')
            )
            ?.includes('server-tmux-status.ts')
        ) {
          counts.producerKeyed++
        }
        return keyed(subject)
      })
      await postHookEvent(server, tmuxTestBody(), '/hook/opencode')
      phase = 'capture'
      const retire = server.capturePaneAuthorityRetirement(TMUX_TEST_PANE)
      installTestLaunchAuthority(server, [
        { paneKey: TMUX_TEST_PANE, token: 'generation', connectionId: null }
      ])
      expect(server.getStatusSnapshotForPane(TMUX_TEST_PANE)[0]?.launchToken).toBe('generation')
      phase = 'callback'
      retire()
      phase = 'assertions'
      expect(server.getStatusSnapshotForPane(TMUX_TEST_PANE)).toHaveLength(0)
      expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(size)
      console.log(
        'CANONICAL_OPERATION_COUNTS',
        JSON.stringify({ size, ...counts, otherSources, subscribers: server.measuredSubscribers })
      )
      expect(counts.producerLists).toBe(0)
      expect(counts.captureLists).toBe(0)
      expect(counts.callbackLists).toBe(0)
      expect(counts.producerKeyed).toBe(1)
    }
  )
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
