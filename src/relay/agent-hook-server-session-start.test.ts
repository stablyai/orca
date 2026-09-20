import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('RelayAgentHookServer Codex SessionStart', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-hook-session-start-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards Codex SessionStart identity with the next real status event', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', payload })
        })

      expect(
        (
          await post({
            hook_event_name: 'SessionStart',
            session_id: 'codex-relay-session'
          })
        ).status
      ).toBe(204)
      expect(forward).not.toHaveBeenCalled()

      expect(
        (await post({ hook_event_name: 'UserPromptSubmit', prompt: 'relay this status' })).status
      ).toBe(204)
      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        source: 'codex',
        providerSession: { key: 'session_id', id: 'codex-relay-session' },
        payload: { state: 'working', prompt: 'relay this status' }
      })
    } finally {
      server.stop()
    }
  })

  it('deduplicates Codex SessionStart while retaining replay until working resumes', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/codex`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token
          },
          body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', payload })
        })

      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'remote old session' })
      forward.mockClear()
      await post({ hook_event_name: 'SessionStart', session_id: 'relay-new-session' })
      await post({ hook_event_name: 'SessionStart', session_id: 'relay-new-session' })

      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        source: 'codex',
        paneKey: PANE_KEY,
        hookEventName: 'SessionStart',
        providerSession: { key: 'session_id', id: 'relay-new-session' },
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      })
      expect(forward.mock.calls[0][0].payload).not.toMatchObject({ state: 'done' })

      forward.mockClear()
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        source: 'codex',
        paneKey: PANE_KEY,
        hookEventName: 'SessionStart',
        isReplay: true,
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      })
      expect(forward.mock.calls[0][0].payload).not.toMatchObject({ state: 'done' })

      forward.mockClear()
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'new session working' })
      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        source: 'codex',
        paneKey: PANE_KEY,
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: 'relay-new-session' },
        payload: { state: 'working', prompt: 'new session working', agentType: 'codex' }
      })

      forward.mockClear()
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0]).toMatchObject({
        hookEventName: 'UserPromptSubmit',
        isReplay: true,
        payload: { state: 'working', prompt: 'new session working', agentType: 'codex' }
      })
    } finally {
      server.stop()
    }
  })
})
