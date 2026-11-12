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
import { buildBody } from '../server.test-fixtures'

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

function hook(index: number, sessionId: string) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      { hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: `task ${index}` },
      { paneKey: paneKey(index), tabId: `tab-${index}` }
    ),
    'production'
  )
  if (!event) {
    throw new Error('hook was rejected')
  }
  return event
}

async function serverWith(panes: number): Promise<AgentHookServer> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-scaling-'))
  const server = new AgentHookServer()
  cleanups.push(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  await server.start({ env: 'production', userDataPath: dir })
  // A real status subscriber, so internal notifications are built on every mutation.
  cleanups.push(server.subscribeStatusChanges(() => {}))
  for (let index = 0; index < panes; index++) {
    server.ingestRemote(hook(index, `session-${index}`), WSL)
  }
  return server
}

function countIdentityWork() {
  return {
    assign: vi.spyOn(PaneAgentIdentities.prototype, 'assign'),
    storeIdentify: vi.spyOn(AgentIdentityStore.prototype, 'identify'),
    storeHas: vi.spyOn(AgentIdentityStore.prototype, 'has')
  }
}

describe.each([200, 2_000])('terminal agent ids at %i panes', (panes) => {
  it('names a pane only when its provider key changes', async () => {
    const server = await serverWith(panes)
    const before = server.getStatusSnapshot()
    expect(before.filter((row) => row.orcaSessionId).length).toBe(panes)
    const counts = countIdentityWork()

    // Unchanged snapshots copy each row's id: no key work, no store work.
    expect(server.getStatusSnapshot().map((row) => row.orcaSessionId)).toEqual(
      before.map((row) => row.orcaSessionId)
    )
    expect(counts.assign).not.toHaveBeenCalled()
    expect(counts.storeIdentify).not.toHaveBeenCalled()

    // `/clear` in pane 0: only that pane's new key is named, in at most one store transaction;
    // the notifications this mutation builds do no identity work for the other panes.
    server.ingestRemote(hook(0, 'session-0-cleared'), WSL)
    for (const [sighting] of counts.assign.mock.calls) {
      expect(['session-0', 'session-0-cleared']).toContain(sighting.providerSession?.id)
    }
    expect(counts.storeIdentify.mock.calls.length).toBeLessThanOrEqual(1)
    const after = server.getStatusSnapshot()
    const pane0 = (rows: typeof after) => rows.find((row) => row.paneKey === paneKey(0))
    expect(pane0(after)?.orcaSessionId).toBeTruthy()
    expect(pane0(after)?.orcaSessionId).not.toBe(pane0(before)?.orcaSessionId)
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
