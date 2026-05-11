import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'

describe('RelayAgentHookServer', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-hook-server-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('forwards a parsed Claude UserPromptSubmit POST as a normalized envelope', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: 'tab-1:0',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }
        })
      })
      expect(res.status).toBe(204)
      expect(forward).toHaveBeenCalledTimes(1)
      const envelope = forward.mock.calls[0][0]
      expect(envelope.source).toBe('claude')
      expect(envelope.paneKey).toBe('tab-1:0')
      expect(envelope.tabId).toBe('tab-1')
      expect(envelope.connectionId).toBeNull()
      expect(envelope.payload.state).toBe('working')
      expect(envelope.payload.prompt).toBe('hi')
      // Why: the relay forwards body env/version verbatim so Orca's existing
      // warn-once cross-build / dev-vs-prod diagnostics still fire on remote.
      expect(envelope.env).toBe('remote')
      expect(envelope.version).toBe('1')
    } finally {
      server.stop()
    }
  })

  it('rejects requests with the wrong bearer token (403)', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port } = server.getCoordinates()
      const res = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': 'wrong'
        },
        body: '{}'
      })
      expect(res.status).toBe(403)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('replays cached payloads on demand', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: 'tab-1:0',
          tabId: 'tab-1',
          env: 'remote',
          version: '1',
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'cache me' }
        })
      })
      forward.mockClear()
      const replayed = server.replayCachedPayloadsForPanes()
      expect(replayed).toBe(1)
      expect(forward).toHaveBeenCalledTimes(1)
      expect(forward.mock.calls[0][0].payload.prompt).toBe('cache me')
      // Why: replay must preserve the wire envelope's env/version (and source)
      // so Orca's warn-once cross-build / dev-vs-prod diagnostics fire on
      // replayed events the same as on live POST events.
      expect(forward.mock.calls[0][0].source).toBe('claude')
      expect(forward.mock.calls[0][0].env).toBe('remote')
      expect(forward.mock.calls[0][0].version).toBe('1')
    } finally {
      server.stop()
    }
  })

  it('does not replay paneKeys after clearPaneState', async () => {
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: 'tab-1:0',
          payload: { hook_event_name: 'UserPromptSubmit', prompt: 'gone' }
        })
      })
      server.clearPaneState('tab-1:0')
      forward.mockClear()
      const replayed = server.replayCachedPayloadsForPanes()
      expect(replayed).toBe(0)
      expect(forward).not.toHaveBeenCalled()
    } finally {
      server.stop()
    }
  })

  it('exposes ORCA_AGENT_HOOK_* env vars after start', async () => {
    const forward = vi.fn()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const env = server.buildPtyEnv()
      expect(env.ORCA_AGENT_HOOK_PORT).toMatch(/^\d+$/)
      expect(env.ORCA_AGENT_HOOK_TOKEN).toBeTruthy()
      expect(env.ORCA_AGENT_HOOK_ENV).toBe('remote')
      expect(env.ORCA_AGENT_HOOK_VERSION).toBe('1')
      expect(env.ORCA_AGENT_HOOK_ENDPOINT).toBeTruthy()
    } finally {
      server.stop()
    }
  })
})
