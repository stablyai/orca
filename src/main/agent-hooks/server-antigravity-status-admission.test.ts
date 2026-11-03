import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

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
