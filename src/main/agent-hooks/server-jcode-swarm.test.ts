import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'
import {
  rootMetadata,
  workerMetadata,
  tigressHooks
} from '../../shared/agent-hook-listener-jcode-swarm-fixtures'
import { paneHasStateClaims } from '../../shared/agent-hook-listener/listener-state'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'

describe('Jcode main host acceptance', () => {
  let dir: string
  let server: AgentHookServer
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-main-swarm-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    server = new AgentHookServer()
    await server.start({ userDataPath: dir, env: 'production' })
  })
  afterEach(() => {
    server.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  function documents() {
    const sessions = join(dir, 'jcode', 'sessions')
    mkdirSync(sessions, { recursive: true })
    for (const metadata of [rootMetadata, workerMetadata, { ...rootMetadata, id: 'old-root' }]) {
      writeFileSync(join(sessions, `${metadata.id}.json`), JSON.stringify(metadata))
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 251)
  }
  async function post(payload: Record<string, unknown>, launchToken?: string) {
    expect(
      (await postHookEvent(server, buildBody(payload, { launchToken }), '/hook/jcode')).status
    ).toBe(204)
  }
  const start = () => ({ ...tigressHooks[0], event: 'turn_start', prompt: 'root prompt' })
  const end = () => ({
    ...start(),
    event: 'turn_end',
    status: 'ok',
    last_assistant_text: 'root reply'
  })

  it.each(['quit', 'dismissed'])(
    'resumes the same root after %s in the same pane',
    async (mode) => {
      documents()
      await post(start())
      await post(end())
      // Negative control: captured root id quits and resumes in the same pane.
      await post({ ...tigressHooks[0], event: 'session_end', source: 'close' })
      if (mode === 'dismissed') {
        server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
      }
      await post({ ...tigressHooks[0], source: 'resume' })
      await post(start())
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        providerSession: { id: rootMetadata.id }
      })
    }
  )

  it('clears rowless crash ownership before adopting a new parentless session', async () => {
    documents()
    await post(tigressHooks[0])
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)
    // Negative control: next shell-launched root has a different readable parentless id.
    await post({ ...tigressHooks[0], session_id: 'old-root' })
    await post({ ...start(), session_id: 'old-root' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      providerSession: { id: 'old-root' }
    })
  })

  it('publishes a silent working child as unverifiable, then restores it on activity', async () => {
    documents()
    vi.restoreAllMocks()
    vi.useFakeTimers()
    await post(start())
    await post(tigressHooks[4])
    await post(end())
    const settled = server.getStatusSnapshot()[0]
    const seen: EnrichedAgentHookEventPayload[] = []
    server.setListener((event) => seen.push(event))
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      subagents: [{ state: 'working' }]
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.at(-1)?.payload).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done' },
      subagents: [{ state: 'unverifiable' }]
    })
    expect(seen.at(-1)?.payload.mainAgent).toEqual(settled.mainAgent)
    expect(seen.at(-1)?.hookEventName).toBeUndefined()
    expect(server.getStatusSnapshot()[0].turnEndedAt).toBe(settled.turnEndedAt)
    // Negative control: captured root tool attributed to this worker as pre_tool.
    await post({ ...tigressHooks[1], session_id: workerMetadata.id, event: 'pre_tool' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [{ state: 'working' }]
    })
  })

  it('shows a known worker before the trusted resumed root emits its first hook', async () => {
    documents()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'jcode',
      providerSession: { key: 'session_id', id: rootMetadata.id },
      launchedAt: Date.now()
    })
    await post(tigressHooks[4])
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      providerSession: { id: rootMetadata.id },
      state: 'working',
      mainAgent: { state: 'done' },
      subagents: [{ id: workerMetadata.id, state: 'working' }]
    })
  })

  it('ignores an obsolete launch while the newer root still has only launch identity', () => {
    const launchedAt = Date.now()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'jcode',
      providerSession: { key: 'session_id', id: 'fresh-root' },
      launchedAt
    })
    const state = server._getStateForTests()
    const before = structuredClone({
      ...state,
      lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
    })
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'jcode',
      providerSession: { key: 'session_id', id: 'obsolete-root' },
      launchedAt: launchedAt - 1000
    })
    expect(
      structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
    ).toEqual(before)
  })

  it('keeps root identity and root fields through the captured worker lifecycle', async () => {
    documents()
    const identities: string[] = []
    server.subscribeProviderSessionChanges((rows) =>
      identities.push(...rows.map((row) => row.sessionId))
    )
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'jcode',
      providerSession: { key: 'session_id', id: rootMetadata.id },
      launchedAt: Date.now()
    })
    await post(start())
    for (const payload of [tigressHooks[2], tigressHooks[4], tigressHooks[5]]) {
      await post(payload)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        providerSession: { id: rootMetadata.id },
        prompt: 'root prompt',
        model: start().model,
        mainAgent: { state: 'working' }
      })
    }
    expect(server.getStatusSnapshot()[0].subagents).toEqual([
      expect.objectContaining({
        id: workerMetadata.id,
        state: 'idle',
        model: 'claude-haiku-5-5',
        agentType: 'retriever'
      })
    ])
    await post({ ...tigressHooks[2], event: 'session_end', source: 'close' })
    expect(server.getStatusSnapshot()[0].subagents).toBeUndefined()
    expect(new Set(identities)).toEqual(new Set([rootMetadata.id]))
  })

  it.each(['http', 'spool'])(
    'delayed_metadata_preserves_buffered_root_boundaries_before_worker_ingress via %s',
    async (transport) => {
      const seen: EnrichedAgentHookEventPayload[] = []
      server.setListener((event) => seen.push(event))
      if (transport === 'http') {
        await post(start(), 'launch-root')
        await post(end(), 'launch-root')
      } else {
        server.stop()
        const spool = join(dir, 'agent-hooks', 'spool')
        mkdirSync(spool, { recursive: true })
        writeFileSync(
          join(spool, 'jcode.jsonl'),
          `${[start(), end()]
            .map((payload) =>
              JSON.stringify({
                paneKey: PANE,
                tabId: 'tab-1',
                worktreeId: 'wt-1',
                source: 'jcode',
                launchToken: 'launch-root',
                payload,
                receivedAt: Date.now()
              })
            )
            .join('\n')}\n`
        )
        server = new AgentHookServer()
        await server.start({ userDataPath: dir, env: 'production' })
        server.setListener((event) => seen.push(event))
      }
      expect(server.getStatusSnapshot()).toEqual([])
      documents()
      await post(tigressHooks[2])
      expect(seen.map((event) => event.hookEventName)).toEqual([
        'turn_start',
        'turn_end',
        undefined
      ])
      expect(seen.slice(0, 2).map((event) => event.launchToken)).toEqual([
        'launch-root',
        'launch-root'
      ])
      expect(seen.slice(0, 2).map((event) => event.isReplay === true)).toEqual([
        transport === 'spool',
        transport === 'spool'
      ])
      expect(seen[0].hasExplicitPrompt).toBe(true)
      if (transport === 'http') {
        expect(seen[1].turnEndDisposition).toBe('identified')
        expect(Number.isFinite(seen[1].turnEndedAt)).toBe(true)
        expect(seen[2].turnEndedAt).toBe(seen[1].turnEndedAt)
      } else {
        expect(seen[1].turnEndedAt).toBeUndefined()
      }
      expect(seen[2].hasExplicitPrompt).toBeUndefined()
    }
  )

  it.each(['readable', 'pending', 'buffered'])(
    'rejected_old_launch_before_fresh_root_first_hook_does_not_bind: %s',
    async (metadata) => {
      const state = server._getStateForTests()
      server.retirePaneAuthority(PANE)
      server.ingestRemote(
        {
          paneKey: PANE,
          source: 'jcode',
          hookEventName: 'turn_start',
          launchToken: 'old',
          payload: { state: 'done', prompt: '', agentType: 'jcode' }
        },
        null
      )
      // Negative control: old process has a distinct root; a later SessionStart changes launch authority.
      const oldStart = { ...start(), session_id: 'old-root' }
      if (metadata === 'buffered') {
        await post(oldStart, 'old')
        expect(state.jcodeSessions.pending).toHaveLength(1)
      }
      server.ingestRemote(
        {
          paneKey: PANE,
          source: 'codex',
          hookEventName: 'SessionStart',
          launchToken: 'fresh',
          payload: { state: 'done', prompt: '', agentType: 'codex' }
        },
        null
      )
      if (metadata !== 'pending') {
        documents()
      }
      const before = structuredClone({
        ...state,
        lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
      })
      await post(oldStart, 'old')
      expect(
        structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
      ).toEqual(before)
      documents()
      await post({ ...start(), prompt: 'fresh prompt' }, 'fresh')
      await post(tigressHooks[4], 'fresh')
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        providerSession: { id: rootMetadata.id },
        prompt: 'fresh prompt',
        model: start().model,
        subagents: [expect.objectContaining({ id: workerMetadata.id })]
      })
    }
  )

  it.each(['drop', 'clear'])(
    'cannot resurrect a removed root from later worker events: %s',
    async (method) => {
      documents()
      await post(start())
      await post(tigressHooks[4])
      expect(server.getStatusSnapshot()[0].subagents?.[0].id).toBe(workerMetadata.id)
      if (method === 'drop') {
        server.dropStatusEntry(PANE)
      } else {
        server.clearPaneState(PANE)
      }
      const state = server._getStateForTests()
      expect(state.jcodeRootPayloadByPaneKey.has(PANE)).toBe(false)
      expect(state.jcodeSubagentRosterByPaneKey.has(PANE)).toBe(false)
      const before = server.getStatusSnapshot()
      await post(tigressHooks[5])
      expect(server.getStatusSnapshot()).toEqual(before)
    }
  )

  it('does not release pending inputs from a disabled status-hook generation', async () => {
    await post({ ...start(), prompt: 'obsolete generation' })
    expect(server._getStateForTests().jcodeSessions.pending).toHaveLength(1)
    server.setStatusHooksEnabled(false)
    server.setStatusHooksEnabled(true)
    documents()
    await post(tigressHooks[2])
    expect(server.getStatusSnapshot()).toEqual([])
    await post({ ...start(), prompt: 'current generation' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      prompt: 'current generation',
      providerSession: { id: rootMetadata.id }
    })
  })

  it('rejects root close under another owner, then teardown removes every Jcode claim', async () => {
    documents()
    await post(start())
    await post(tigressHooks[4])
    const state = server._getStateForTests()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
    server.ingestTerminalStatus({
      paneKey: PANE,
      payload: { state: 'working', prompt: 'Claude owns pane', agentType: 'claude' }
    })
    expect(server.getStatusSnapshot()[0].agentType).toBe('claude')
    const before = structuredClone({
      ...state,
      lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
    })
    await post({ ...start(), event: 'session_end' })
    expect(
      structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
    ).toEqual(before)
    server.clearPaneState(PANE)
    expect(paneHasStateClaims(state, PANE)).toBe(false)
    expect(state.jcodeSessions.bindings.size).toBe(0)
    expect(state.jcodeSessions.pending).toEqual([])
    expect(state.jcodeSubagentRosterByPaneKey.size).toBe(0)
  })

  it('warns once for accepted version/env mismatches', async () => {
    documents()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let index = 0; index < 2; index++) {
      await postHookEvent(
        server,
        buildBody(start(), { env: 'development', version: 'wrong-version' }),
        '/hook/jcode'
      )
    }
    expect(warn.mock.calls.filter((args) => String(args[0]).includes('version'))).toHaveLength(1)
    expect(
      warn.mock.calls.filter((args) => String(args[0]).includes('received development hook'))
    ).toHaveLength(1)
  })

  it.each([false, true])(
    'reaps restored children except matching live turns: confirmed=%s',
    async (confirmed) => {
      documents()
      await post(start())
      await post(tigressHooks[4])
      server.stop()
      server = new AgentHookServer()
      await server.start({ userDataPath: dir, env: 'production' })
      expect(server.getStatusSnapshot()[0].subagents?.[0].id).toBe(workerMetadata.id)
      if (confirmed) {
        await post(tigressHooks[4])
      }
      await post(end())
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: confirmed ? 'working' : 'done',
        mainAgent: { state: 'done' }
      })
      expect(server.getStatusSnapshot()[0].subagents?.length ?? 0).toBe(confirmed ? 1 : 0)
    }
  )

  it.each([false, true])(
    'cancel_settle_then_worker_event_keeps_root_done: active child=%s',
    async (active) => {
      documents()
      await post(start())
      if (active) {
        await post(tigressHooks[4])
      }
      vi.useFakeTimers()
      server.observeJcodeTerminalTitle(PANE, '🌐 jcode/castle Tigress · work ~10s')
      server.observeJcodeTerminalTitle(PANE, '🌐 jcode/castle Tigress · last ~10s')
      vi.advanceTimersByTime(2000)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: active ? 'working' : 'done',
        mainAgent: { state: 'done' },
        providerSession: { id: rootMetadata.id },
        prompt: 'root prompt',
        model: start().model
      })
      vi.useRealTimers()
      const before = server.getStatusSnapshot()
      await post(tigressHooks[1])
      expect(server.getStatusSnapshot()).toEqual(before)
      await post(active ? tigressHooks[5] : tigressHooks[2])
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        mainAgent: { state: 'done' },
        providerSession: { id: rootMetadata.id },
        prompt: 'root prompt',
        model: start().model
      })
    }
  )
})
