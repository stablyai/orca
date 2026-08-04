import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const PANE_KEY = makePaneKey('manual-compact', '11111111-1111-4111-8111-111111111111')
const PROMPT_ID_1 = '22222222-2222-4222-8222-222222222222'
const PROMPT_ID_2 = '33333333-3333-4333-8333-333333333333'
const SESSION = { key: 'session_id' as const, id: 'session-a' }

type ClaudeHook = {
  hook_event_name: string
  prompt?: string
  prompt_id: string
  session_id: string
  trigger?: 'manual' | 'auto'
  agent_id?: string
  agent_type?: string
}

function claudeHook(
  hookEventName: string,
  promptId: string,
  extra: Partial<ClaudeHook> = {}
): ClaudeHook {
  return {
    hook_event_name: hookEventName,
    prompt_id: promptId,
    session_id: 'session-a',
    ...extra
  }
}

function manualEnvelope(hookEventName: string, state: 'working' | 'done') {
  return {
    source: 'claude' as const,
    paneKey: PANE_KEY,
    hasExplicitPrompt: hookEventName === 'UserPromptSubmit' ? true : undefined,
    hookEventName,
    providerPromptId: hookEventName === 'UserPromptSubmit' ? PROMPT_ID_2 : PROMPT_ID_1,
    compactTrigger: hookEventName === 'UserPromptSubmit' ? undefined : ('manual' as const),
    providerSession: SESSION,
    payload: { state, prompt: 'work before compact', agentType: 'claude' as const }
  }
}

function postHook(port: number, token: string, payload: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': token
    },
    body: JSON.stringify({ paneKey: PANE_KEY, payload })
  })
}

describe('manual Claude compact hook stream', () => {
  const servers: { stop: () => void }[] = []
  const temporaryPaths: string[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.stop()
    }
    for (const path of temporaryPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('settles an exact local HTTP lifecycle and rejects a duplicate completion', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const events: string[] = []
    const unsubscribe = server.subscribeEnrichedStatus((event) => {
      events.push(`${event.hookEventName}:${event.payload.state}`)
    })

    await postHook(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('UserPromptSubmit', PROMPT_ID_2, { prompt: 'work before compact' })
    )
    await postHook(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('PreCompact', PROMPT_ID_1, { trigger: 'manual' })
    )
    await postHook(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('SubagentStart', PROMPT_ID_1, {
        agent_id: 'compact-agent',
        agent_type: 'general-purpose'
      })
    )
    await postHook(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('SubagentStop', PROMPT_ID_1, {
        agent_id: 'compact-agent',
        agent_type: 'general-purpose'
      })
    )
    await postHook(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('PostCompact', PROMPT_ID_1, { trigger: 'manual' })
    )
    await postHook(
      Number(env.ORCA_AGENT_HOOK_PORT),
      env.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('PostCompact', PROMPT_ID_1, { trigger: 'manual' })
    )

    expect(events).toEqual([
      'UserPromptSubmit:working',
      'PreCompact:working',
      'SubagentStart:working',
      'SubagentStop:working',
      'PostCompact:done'
    ])
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        state: 'done',
        prompt: 'work before compact',
        agentType: 'claude'
      })
    ])
    unsubscribe()
  })

  it('preserves the manual identity over relay and rejects stale transport identities', async () => {
    const main = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    const emitted: string[] = []
    const connectionId = 'conn-a'
    const endpointDir = mkdtempSync(join(tmpdir(), 'orca-compact-relay-'))
    temporaryPaths.push(endpointDir)
    const relay = new RelayAgentHookServer({
      endpointDir,
      token: 'manual-compact-token',
      forward: (envelope) => {
        forwarded.push(envelope)
        main.ingestRemote(envelope, connectionId)
      }
    })
    servers.push(main, relay)
    const unsubscribe = main.subscribeEnrichedStatus((event) => {
      emitted.push(`${event.hookEventName}:${event.payload.state}`)
    })
    await relay.start({ publishEndpoint: false })
    const coordinates = relay.getCoordinates()

    await postHook(
      coordinates.port,
      coordinates.token,
      claudeHook('UserPromptSubmit', PROMPT_ID_2, { prompt: 'work before compact' })
    )
    // A restarted relay has no prior listener cache; main still owns the status boundary.
    relay.clearPaneState(PANE_KEY)
    await postHook(
      coordinates.port,
      coordinates.token,
      claudeHook('PreCompact', PROMPT_ID_1, { trigger: 'manual' })
    )
    const validPost = {
      ...forwarded.at(-1)!,
      hookEventName: 'PostCompact',
      payload: {
        state: 'done' as const,
        prompt: 'work before compact',
        agentType: 'claude' as const
      }
    }

    main.ingestRemote({ ...validPost, providerPromptId: PROMPT_ID_2 }, 'conn-a')
    main.ingestRemote({ ...validPost, providerPromptId: undefined }, 'conn-a')
    main.ingestRemote({ ...validPost, providerSession: undefined }, 'conn-a')
    main.ingestRemote({ ...validPost, source: 'codex' }, 'conn-a')
    main.ingestRemote(validPost, 'conn-b')

    expect(emitted).toEqual(['UserPromptSubmit:working', 'PreCompact:working'])
    expect(main.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      prompt: 'work before compact'
    })

    await postHook(
      coordinates.port,
      coordinates.token,
      claudeHook('SubagentStart', PROMPT_ID_1, {
        agent_id: 'compact-agent',
        agent_type: 'general-purpose'
      })
    )
    await postHook(
      coordinates.port,
      coordinates.token,
      claudeHook('SubagentStop', PROMPT_ID_1, {
        agent_id: 'compact-agent',
        agent_type: 'general-purpose'
      })
    )
    await postHook(
      coordinates.port,
      coordinates.token,
      claudeHook('PostCompact', PROMPT_ID_1, { trigger: 'manual' })
    )

    expect(forwarded.at(-1)).toMatchObject({
      source: 'claude',
      providerPromptId: PROMPT_ID_1,
      compactTrigger: 'manual',
      providerSession: SESSION,
      hookEventName: 'PostCompact'
    })
    expect(emitted.at(-1)).toBe('PostCompact:done')
    expect(emitted.slice(-3)).toEqual([
      'SubagentStart:working',
      'SubagentStop:working',
      'PostCompact:done'
    ])
    expect(main.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      prompt: 'work before compact'
    })
    unsubscribe()
  })

  it('invalidates a compact completion when later provider work owns the pane', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestRemote(manualEnvelope('UserPromptSubmit', 'working'), 'conn-a')
    server.ingestRemote(manualEnvelope('PreCompact', 'working'), 'conn-a')
    server.ingestRemote(
      {
        source: 'codex',
        paneKey: PANE_KEY,
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        payload: { state: 'working', prompt: 'new work', agentType: 'codex' }
      },
      'conn-a'
    )
    server.ingestRemote({ ...manualEnvelope('PreCompact', 'working'), isReplay: true }, 'conn-a')
    server.ingestRemote(manualEnvelope('PostCompact', 'done'), 'conn-a')

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      prompt: 'new work',
      agentType: 'claude'
    })
    expect(server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
      source: 'codex',
      hookEventName: 'UserPromptSubmit'
    })
  })

  it('keeps automatic compact hooks working without settling the turn', async () => {
    const main = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    const endpointDir = mkdtempSync(join(tmpdir(), 'orca-auto-compact-relay-'))
    temporaryPaths.push(endpointDir)
    const relay = new RelayAgentHookServer({
      endpointDir,
      forward: (envelope) => {
        forwarded.push(envelope)
        main.ingestRemote(envelope, 'conn-auto')
      }
    })
    servers.push(main, relay)
    await relay.start({ publishEndpoint: false })
    const { port, token } = relay.getCoordinates()

    await postHook(
      port,
      token,
      claudeHook('UserPromptSubmit', PROMPT_ID_1, { prompt: 'continue the task' })
    )
    await postHook(port, token, claudeHook('PreCompact', PROMPT_ID_1, { trigger: 'auto' }))
    await postHook(port, token, claudeHook('PostCompact', PROMPT_ID_1, { trigger: 'auto' }))

    expect(forwarded.map((event) => event.hookEventName)).toEqual([
      'UserPromptSubmit',
      'PreCompact',
      'PostCompact'
    ])
    expect(main.getStatusSnapshot()[0]).toMatchObject({ state: 'working', agentType: 'claude' })
    expect(main._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)).toMatchObject({
      hookEventName: 'PostCompact',
      compactTrigger: undefined
    })
  })

  it('rejects unproven compact sources at the main relay boundary', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestRemote(
      {
        ...manualEnvelope('PreCompact', 'working'),
        source: 'kimi',
        payload: { state: 'working', prompt: '', agentType: 'kimi' }
      },
      'conn-kimi'
    )
    server.ingestRemote(
      { ...manualEnvelope('PreCompact', 'working'), compactTrigger: undefined },
      'conn-auto'
    )

    expect(server.getStatusSnapshot()).toEqual([])
    expect(server._getStateForTests().lastStatusByPaneKey.size).toBe(0)
  })

  it('hydrates a manual PreCompact identity and accepts only its exact local completion', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-compact-restore-'))
    temporaryPaths.push(userDataPath)
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const firstEnv = first.buildPtyEnv()
    await postHook(
      Number(firstEnv.ORCA_AGENT_HOOK_PORT),
      firstEnv.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('UserPromptSubmit', PROMPT_ID_2, { prompt: 'work before compact' })
    )
    await postHook(
      Number(firstEnv.ORCA_AGENT_HOOK_PORT),
      firstEnv.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('PreCompact', PROMPT_ID_1, { trigger: 'manual' })
    )
    first.stop()

    const restored = new AgentHookServer()
    servers.push(restored)
    await restored.start({ env: 'production', userDataPath })
    const restoredEnv = restored.buildPtyEnv()
    await postHook(
      Number(restoredEnv.ORCA_AGENT_HOOK_PORT),
      restoredEnv.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('PostCompact', PROMPT_ID_2, { trigger: 'manual' })
    )
    expect(restored.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })

    await postHook(
      Number(restoredEnv.ORCA_AGENT_HOOK_PORT),
      restoredEnv.ORCA_AGENT_HOOK_TOKEN,
      claudeHook('PostCompact', PROMPT_ID_1, { trigger: 'manual' })
    )
    expect(restored.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      prompt: 'work before compact',
      agentType: 'claude'
    })
  })
})
