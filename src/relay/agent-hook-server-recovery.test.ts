import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('relay hook server recovery', () => {
  it('sanitizes malformed provider session metadata during hydration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-recovery-'))
    writeFileSync(
      join(dir, 'hook-status-cache.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            event: {
              paneKey: PANE_KEY,
              payload: { state: 'working', prompt: 'bad', agentType: 'codex' },
              providerSession: { key: 'session_id', id: 'session-1', transcriptPath: 5 }
            },
            meta: { source: 'codex' }
          }
        ]
      })
    )
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({ providerSession: { key: 'session_id', id: 'session-1' } })
      )
    } finally {
      server.stop()
    }
  })

  it('ignores request continuations that arrive after the relay stops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-recovery-'))
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    server.stop()
    ;(
      server as unknown as { applyEvent: (event: AgentHookEventPayload, source: 'codex') => void }
    ).applyEvent(
      {
        paneKey: PANE_KEY,
        connectionId: null,
        payload: { state: 'working', prompt: 'late', agentType: 'codex' }
      },
      'codex'
    )
    expect(server.replayCachedPayloadsForPanes()).toBe(0)
    expect(forward).not.toHaveBeenCalled()
  })
})
