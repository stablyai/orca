import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer } from './server'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
afterEach(() => probe.mockReset().mockResolvedValue('live'))

it.each(['local', 'relay'] as const)(
  'retains Antigravity status admission without promoting a raw locator over %s',
  async (transport) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-admission-'))
    const transcriptPath = join(dir, 'transcript.jsonl')
    const root = '6bba92d4-47e1-440a-9571-b12bb2d474bc'
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Reply with OK.' })}\n`
    )
    const server = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    const relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (event) => {
        forwarded.push(event)
        server.ingestRemote(event, 'host-1')
      }
    })
    try {
      await server.start({ env: 'production' })
      if (transport === 'relay') {
        await relay.start()
      }
      const post = async (source: 'antigravity' | 'codex', payload: Record<string, unknown>) => {
        const body = buildBody(payload)
        const response =
          transport === 'local'
            ? await postHookEvent(server, body, `/hook/${source}`)
            : await fetch(`http://127.0.0.1:${relay.getCoordinates().port}/hook/${source}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Orca-Agent-Hook-Token': relay.getCoordinates().token
                },
                body: JSON.stringify(body)
              })
        expect(response.status).toBe(204)
      }
      const agy = (conversationId: string, extra: Record<string, unknown> = {}) => ({
        hook_event_name: 'PreInvocation',
        conversationId,
        transcriptPath,
        lastUserInput: 'Reply with OK.',
        ...extra
      })
      await post('antigravity', agy(root))
      await post('antigravity', agy(root, { hook_event_name: 'Stop', fullyIdle: true }))
      rmSync(transcriptPath)
      await post('antigravity', agy('unknown-child', { lastUserInput: '' }))
      const delayedUnknown = forwarded.at(-1)
      await post('antigravity', agy(root, { hook_event_name: 'Stop', fullyIdle: true }))
      await post('codex', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'nested',
        prompt: 'review'
      })
      expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      if (transport === 'relay') {
        if (!delayedUnknown) {
          throw new Error('Missing child relay event')
        }
        expect(delayedUnknown.agentPresence).toEqual({
          agent: 'antigravity',
          session: 'unknown-child'
        })
        server.ingestRemote(delayedUnknown, 'host-1')
        expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      }
      await post('antigravity', agy('unknown-child', { lastUserInput: '' }))
      expect(server.getStatusSnapshot()[0]?.agentType).toBe('codex')
      await post('antigravity', agy(root))
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'antigravity',
        state: 'working'
      })
      expect(server.getStatusSnapshot()[0]?.providerSession).toEqual({
        key: 'conversation_id',
        id: root
      })
      expect(server.getStatusSnapshot()[0]).not.toHaveProperty('statusAdmissionSession')
      expect(JSON.stringify(forwarded)).not.toContain('statusAdmissionSession')
    } finally {
      server.stop()
      relay.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.each(['exit', 'suspension'] as const)(
  'preserves relay Antigravity ownership until host-proved %s',
  async (release) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-review-relay-'))
    const transcriptPath = join(dir, 'root.jsonl')
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'task' })}\n`
    )
    const server = new AgentHookServer()
    const forwarded: AgentHookRelayEnvelope[] = []
    let binding: string | undefined
    const relay = new RelayAgentHookServer({
      readHookRootEvidence: async () => ({ verdict: 'root', binding }),
      endpointDir: dir,
      env: 'production',
      forward: (event) => {
        forwarded.push(event)
        server.ingestRemote(event, 'host-1')
      }
    })
    try {
      await server.start({ env: 'production' })
      server.beginRemoteRelaySession('host-1')
      binding = server.relayPaneRootIssuer('host-1')(PANE, 'agy-pane', () => true)
      expect(binding).toBeDefined()
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'grok',
          providerSession: { key: 'session_id', id: 'weak-grok' },
          payload: { agentType: 'grok', state: 'done', prompt: '' }
        },
        'host-1'
      )
      await relay.start()
      const { port, token } = relay.getCoordinates()
      const post = async (source: string, payload: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify(
            buildBody(
              payload,
              source === 'antigravity'
                ? {
                    agentProcess: JSON.stringify({
                      pid: 5001,
                      platform: 'linux',
                      startTime: 'birth-5001'
                    })
                  }
                : {}
            )
          )
        })
        expect(response.status).toBe(204)
      }
      await post('antigravity', {
        hook_event_name: 'PreInvocation',
        conversationId: 'agy-root',
        transcriptPath,
        lastUserInput: 'task'
      })
      await post('antigravity', {
        hook_event_name: 'Stop',
        conversationId: 'agy-root',
        transcriptPath,
        fullyIdle: true
      })
      const beforeReplay = forwarded.length
      expect(relay.replayCachedPayloadsForPanes()).toBe(1)
      expect(forwarded).toHaveLength(beforeReplay + 1)
      const parent = forwarded.at(-1)
      expect(parent?.isReplay).toBe(true)
      expect(parent?.agentPresence).toMatchObject({
        agent: 'antigravity',
        sessionOwner: true,
        paneRoot: binding,
        process: { pid: 5001 }
      })
      await post('grok', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'nested-grok',
        prompt: 'nested task'
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'antigravity',
        providerSession: { id: 'agy-root' }
      })
      expect(forwarded.at(-1)).toBe(parent)
      probe.mockImplementation(async (_identity, _read, _platform, observe) => {
        if (release === 'suspension') {
          observe?.(true)
        }
        return release === 'exit' ? 'exited' : 'unverifiable'
      })
      await relay.checkAgentPresence(PANE)
      expect(forwarded.at(-1)?.agentPresence).toMatchObject({
        agent: 'antigravity',
        process: { pid: 5001 },
        paneRoot: binding,
        ...(release === 'exit' ? { ended: true } : { suspended: true })
      })
      await post('grok', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'grok-direct',
        prompt: 'new task'
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'grok',
        providerSession: { id: 'grok-direct' }
      })
    } finally {
      server.stop()
      relay.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
