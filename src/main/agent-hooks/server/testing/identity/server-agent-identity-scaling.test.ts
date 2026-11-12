import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { AgentIdentityStore } from '../../../identity/agent-identity-store'
import { PaneAgentIdentities } from '../../../identity/pane-agent-identities'
import { AgentHookServer } from '../../agent-hook-server'
import { LastStatusStore } from '../../last-status-store'
import type { LastStatusFile } from '../../server-types'
import { buildBody } from '../server.test-fixtures'
import { TMUX_TEST_ROOT } from '../../../../../shared/tmux-status.test-fixture'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'

const WSL = 'wsl:Ubuntu'
const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function paneKey(index: number): string {
  return makePaneKey(`tab-${index}`, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
}

function tmuxPaneKey(index: number): string {
  return makePaneKey(`tmux-${index}`, `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`)
}

function hook(index: number, sessionId: string, hookEventName = 'UserPromptSubmit') {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      { hook_event_name: hookEventName, session_id: sessionId, prompt: `task ${index}` },
      { paneKey: paneKey(index), tabId: `tab-${index}` }
    ),
    'production'
  )
  if (!event) {
    throw new Error('hook was rejected')
  }
  return event
}

// Fixed, increasing evidence clocks: a later publication is newer, with no wall clock involved.
let tmuxClock = 1_700_000_000_000

class IdentityTestServer extends AgentHookServer {
  /** The tmux owner's own publication path for one selected terminal agent. */
  publishTmuxTerminal(index: number, sessionId: string): void {
    const paneKey = tmuxPaneKey(index)
    const event: AgentHookEventPayload = {
      paneKey,
      tabId: `tmux-${index}`,
      worktreeId: 'workspace',
      connectionId: null,
      source: 'opencode',
      providerSession: { key: 'session_id', id: sessionId },
      payload: { state: 'working', prompt: `tmux ${index}`, agentType: 'opencode' }
    }
    const now = ++tmuxClock
    this.publishTmuxSelectedStatus(
      event,
      now,
      { ...TMUX_TEST_ROOT.scope, kind: 'pty', paneKey },
      now
    )
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-scaling-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function started<T extends AgentHookServer>(server: T, dir = tempDir()): Promise<T> {
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: dir })
  // A real status subscriber, so internal notifications are built on every mutation.
  cleanups.unshift(server.subscribeStatusChanges(() => {}))
  return server
}

async function serverWith(panes: number, tmuxPanes = 0): Promise<IdentityTestServer> {
  const server = await started(new IdentityTestServer())
  for (let index = 0; index < panes; index++) {
    server.ingestRemote(hook(index, `session-${index}`), WSL)
  }
  for (let index = 0; index < tmuxPanes; index++) {
    server.publishTmuxTerminal(index, `tmux-session-${index}`)
  }
  return server
}

function countIdentityWork() {
  return {
    assign: vi.spyOn(PaneAgentIdentities.prototype, 'assign'),
    storeIdentify: vi.spyOn(AgentIdentityStore.prototype, 'identify'),
    storeHas: vi.spyOn(AgentIdentityStore.prototype, 'has'),
    canonicalIdentity: vi.spyOn(PaneAgentIdentities.prototype, 'canonicalIdentity')
  }
}

describe.each([200, 2_000])('terminal agent ids at %i panes', (panes) => {
  it('names a pane only when its provider key changes', async () => {
    const server = await serverWith(panes, panes)
    const before = server.getStatusSnapshot()
    expect(before.filter((row) => row.orcaSessionId).length).toBe(panes * 2)
    const counts = countIdentityWork()

    // Unchanged snapshots copy each row's id: no key work, no store work.
    expect(server.getStatusSnapshot().map((row) => row.orcaSessionId)).toEqual(
      before.map((row) => row.orcaSessionId)
    )
    expect(counts.assign).not.toHaveBeenCalled()
    expect(counts.storeIdentify).not.toHaveBeenCalled()
    counts.canonicalIdentity.mockClear()

    // `/clear` in pane 0: only that pane's new key is named, in at most one store transaction;
    // the notifications this mutation builds do no identity work for the other panes.
    server.ingestRemote(hook(0, 'session-0-cleared'), WSL)
    for (const [sighting] of counts.assign.mock.calls) {
      expect(['session-0', 'session-0-cleared']).toContain(sighting.providerSession?.id)
    }
    expect(counts.storeIdentify.mock.calls.length).toBeLessThanOrEqual(1)
    // A tmux agent's own change likewise: its notification outputs no id, so no canonical id work.
    server.publishTmuxTerminal(1, 'tmux-session-1-cleared')
    expect(counts.canonicalIdentity).not.toHaveBeenCalled()
    expect(counts.storeIdentify.mock.calls.length).toBeLessThanOrEqual(2)
    const after = server.getStatusSnapshot()
    const pane0 = (rows: typeof after) => rows.find((row) => row.paneKey === paneKey(0))
    expect(pane0(after)?.orcaSessionId).toBeTruthy()
    expect(pane0(after)?.orcaSessionId).not.toBe(pane0(before)?.orcaSessionId)
    // Outputs that carry ids still expose the tmux agent's renamed conversation, and Copy agrees.
    const tmux1 = after.find((row) => row.paneKey === tmuxPaneKey(1))?.orcaSessionId
    expect(tmux1).toBeTruthy()
    expect(tmux1).not.toBe(before.find((row) => row.paneKey === tmuxPaneKey(1))?.orcaSessionId)
    expect(server.getStatusSnapshotForPane(tmuxPaneKey(1))[0]?.orcaSessionId).toBe(tmux1)
    expect(server.resolvePaneAgentId(tmuxPaneKey(1), undefined)).toBe(tmux1)
  })

  it('refuses by reading only the panes that carry the id', async () => {
    const server = await serverWith(panes)
    const id = server.getStatusSnapshot().find((row) => row.paneKey === paneKey(1))?.orcaSessionId
    expect(id).toBeTruthy()
    const snapshot = vi.spyOn(server, 'getStatusSnapshot')
    const state = server._getStateForTests()
    const rows = state.lastStatusByPaneKey
    let rowReads = 0
    let rowWalks = 0
    const walk = <T>(iterate: () => T): T => (rowWalks++, iterate())
    Reflect.set(state, 'lastStatusByPaneKey', {
      get: (key: string) => (rowReads++, rows.get(key)),
      has: (key: string) => rows.has(key),
      get size() {
        return rows.size
      },
      keys: () => walk(() => rows.keys()),
      values: () => walk(() => rows.values()),
      entries: () => walk(() => rows.entries()),
      forEach: (callback: Parameters<typeof rows.forEach>[0]) => walk(() => rows.forEach(callback)),
      [Symbol.iterator]: () => walk(() => rows[Symbol.iterator]())
    })
    cleanups.unshift(() => Reflect.set(state, 'lastStatusByPaneKey', rows))

    expect(server.terminalAgentPlaces(id!)).toEqual([{ paneKey: paneKey(1), worktreeId: 'wt-1' }])
    expect(snapshot).not.toHaveBeenCalled()
    expect(rowWalks).toBe(0)
    expect(rowReads).toBe(1)
  })
})

/** Restarts from the saved status document without a disk round trip. */
class RestartingServer extends AgentHookServer {
  constructor(private readonly saved?: LastStatusFile) {
    super()
  }

  savedStatus(): LastStatusFile {
    return this.buildStatusFile()
  }

  protected override getStatusStore(): LastStatusStore | null {
    const saved = this.saved
    const path = this.lastStatusPath
    if (!saved || !path) {
      return super.getStatusStore()
    }
    return new (class extends LastStatusStore {
      override read() {
        return { document: saved, source: 'rows' as const }
      }
    })(path)
  }
}

it('claims a running place only for an agent this runtime has observed', async () => {
  const dir = tempDir()
  const first = await started(new RestartingServer(), dir)
  first.ingestRemote(hook(0, 'session-0', 'Stop'), WSL)
  const id = first.getStatusSnapshot()[0]?.orcaSessionId
  const saved = first.savedStatus()
  first.stop()

  // A saved Done status is history: the agent may have exited while Orca was closed.
  const restarted = await started(new RestartingServer(saved), dir)
  expect(restarted.getStatusSnapshot()[0]).toMatchObject({ state: 'done', orcaSessionId: id })
  expect(restarted.terminalAgentPlaces(id!)).toEqual([])
  restarted.ingestRemote(hook(0, 'session-0'), WSL)
  expect(restarted.terminalAgentPlaces(id!)).toEqual([{ paneKey: paneKey(0), worktreeId: 'wt-1' }])
})

it('publishes a failed first link as nameable, and the click retries it', async () => {
  let down = true
  const path = join(tempDir(), 'agent-identities.db')
  class FailingFirstLinkServer extends AgentHookServer {
    protected override readonly agentIdentities = new PaneAgentIdentities(
      () => path,
      (file) => {
        const store = new AgentIdentityStore(file)
        return {
          readOnly: false,
          has: (id) => store.has(id),
          close: () => store.close(),
          identify: (key) => {
            if (down) {
              throw new Error('database is locked')
            }
            return store.identify(key)
          }
        }
      }
    )
  }
  const server = await started(new FailingFirstLinkServer())
  server.ingestRemote(hook(0, 'session-0'), WSL)
  const row = server.getStatusSnapshot()[0]
  // The host can name this conversation but has not: the field is present and null, which is
  // what offers Copy Agent ID (canPaneOfferAgentId).
  expect(row).toHaveProperty('orcaSessionId', null)
  down = false
  // Still inside the 30 s backoff: only the click resolves it.
  expect(server.resolvePaneAgentId(paneKey(0), undefined)).toMatch(/^claude_/)
})
