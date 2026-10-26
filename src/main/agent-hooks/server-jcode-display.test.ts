import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE as rootPane } from './server.test-fixtures'
import type { SpoolRecord } from '../../shared/agent-hook-spool'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { bindJcodeRootSession } from '../../shared/agent-hook-listener/jcode-session-registry'
import { clearPaneCacheState } from '../../shared/agent-hook-listener/listener-state'
import {
  bindJcodeDisplaySession,
  reserveJcodeSessionTab,
  settleJcodeDisplayPane
} from '../../shared/agent-hook-listener/jcode-display-registry'
import {
  childPane,
  displayMetadata,
  displayRootId,
  displayWorkerId,
  pigletLateTool,
  pigletStart,
  pigletTurn
} from '../../shared/agent-hook-listener-jcode-display-fixtures'

class DisplayServer extends AgentHookServer {
  replay(record: SpoolRecord) {
    return this.ingestSpoolRecord(record)
  }
}

describe('Jcode display routing through main HTTP and spool ingress', () => {
  let dir: string
  let server: DisplayServer
  let childLaunchToken: string
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-main-display-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    const sessions = join(dir, 'jcode', 'sessions')
    mkdirSync(sessions, { recursive: true })
    for (const metadata of displayMetadata) {
      writeFileSync(join(sessions, `${metadata.id}.json`), JSON.stringify(metadata))
    }
    childLaunchToken = randomUUID()
    server = new DisplayServer()
    await server.start({ userDataPath: dir, env: 'production' })
    expect(
      bindJcodeRootSession(server._getStateForTests(), rootPane, displayRootId, 'launch')
    ).toBe(true)
  })
  afterEach(() => {
    server.stop()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  function bind() {
    const state = server._getStateForTests()
    expect(
      reserveJcodeSessionTab(state, {
        sessionId: displayWorkerId,
        paneKey: childPane,
        rootPaneKey: rootPane,
        kind: 'worker'
      })
    ).toEqual({ ok: true })
    expect(
      bindJcodeDisplaySession(state, {
        rootPaneKey: rootPane,
        displayPaneKey: childPane,
        sessionId: displayWorkerId,
        coordinatorSessionId: displayRootId,
        tabId: 'tab-child',
        worktreeId: 'wt-1',
        launchToken: childLaunchToken,
        state: 'open',
        boundAt: Date.now()
      })
    ).toBe(true)
  }
  async function post(payload: Record<string, unknown>) {
    const env = server.buildPtyEnv()
    const body = buildBody(payload)
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/jcode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Connection: 'close',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: new URLSearchParams({
        paneKey: body.paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        env: 'production',
        payload: JSON.stringify(payload)
      })
    })
    expect(response.status).toBe(204)
  }
  async function replay(payload: Record<string, unknown>) {
    await server.replay({ ...buildBody(payload), source: 'jcode', receivedAt: Date.now() - 1_000 })
  }

  it('publishes captured turn only on child, then HTTP drops late post-close tool', async () => {
    bind()
    const seen: EnrichedAgentHookEventPayload[] = []
    server.setListener((event) => seen.push(event))
    await post(pigletStart)
    await post(pigletTurn)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: childPane,
        state: 'working',
        model: 'claude-haiku-5-5',
        providerSession: { key: 'session_id', id: displayWorkerId }
      })
    ])
    expect(seen.at(-1)?.paneKey).toBe(childPane)
    expect(seen.at(-1)?.launchToken === childLaunchToken).toBe(true)
    const before = server.getStatusSnapshot()
    settleJcodeDisplayPane(server._getStateForTests(), childPane)
    seen.length = 0
    await post(pigletLateTool)
    expect(seen).toEqual([])
    expect(server.getStatusSnapshot()).toEqual(before)
  })

  it('HTTP drops late tool after agent-only root cleanup with an Active parentless worker', async () => {
    bind()
    const state = server._getStateForTests()
    expect(settleJcodeDisplayPane(state, childPane)).toBe(true)
    clearPaneCacheState(state, rootPane)
    // Negative control: admit the late tool past the session router's active-turn guard to isolate display drop.
    state.jcodeTurnByPaneKey.set(rootPane, {
      sessionId: displayWorkerId,
      revision: 1,
      active: true,
      lastActivityAt: Date.now()
    })
    const seen: EnrichedAgentHookEventPayload[] = []
    server.setListener((event) => seen.push(event))
    await post(pigletLateTool)
    expect(seen).toEqual([])
    expect(server.getStatusSnapshot()).toEqual([])
    expect(state.jcodeSessions.roots.has(rootPane)).toBe(false)
    expect(state.jcodeSessions.roots.has(childPane)).toBe(false)
  })

  it('spool replay routes child and preserves replay marker without minting completion', async () => {
    bind()
    const seen: EnrichedAgentHookEventPayload[] = []
    server.setListener((event) => seen.push(event))
    await replay(pigletTurn)
    expect(seen.at(-1)).toMatchObject({
      paneKey: childPane,
      isReplay: true,
      providerSession: { id: displayWorkerId }
    })
    // Negative control: captured worker turn boundary shape, same displayed Piglet session.
    await replay({ ...pigletTurn, event: 'turn_end', status: 'ok' })
    expect(seen.at(-1)).toMatchObject({
      paneKey: childPane,
      isReplay: true,
      hookEventName: 'turn_end',
      payload: { state: 'done' }
    })
    expect(seen.at(-1)?.turnEndedAt).toBeUndefined()
    expect(server.getStatusSnapshot().every((row) => row.paneKey === childPane)).toBe(true)
    settleJcodeDisplayPane(server._getStateForTests(), childPane)
    const before = server.getStatusSnapshot()
    seen.length = 0
    await replay(pigletLateTool)
    expect(seen).toEqual([])
    expect(server.getStatusSnapshot()).toEqual(before)
  })

  it('negative control: spool event without display binding never updates root', async () => {
    const before = server.getStatusSnapshot()
    await replay(pigletTurn)
    expect(server.getStatusSnapshot()).toEqual(before)
    expect(server._getStateForTests().jcodeSessions.roots.get(rootPane)).toBe(displayRootId)
    expect(server._getStateForTests().jcodeSessions.pending).toEqual([])
  })
})
