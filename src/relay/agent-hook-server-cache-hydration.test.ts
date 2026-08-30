import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import { RelayAgentHookServer } from './agent-hook-server'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const MALFORMED_LEAF_IDS = [
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
] as const

describe('relay agent-hook server cache hydration', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-hook-server-cache-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips malformed durable entries while hydrating valid status and diagnostics', async () => {
    writeFileSync(
      join(dir, 'hook-status-cache.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            event: { paneKey: makePaneKey('tab-1', MALFORMED_LEAF_IDS[0]) },
            meta: { source: 'claude' }
          },
          {
            event: {
              paneKey: makePaneKey('tab-1', MALFORMED_LEAF_IDS[1]),
              payload: { state: 'working', prompt: 'missing agent type' }
            },
            meta: { source: 'claude' }
          },
          {
            event: {
              paneKey: makePaneKey('tab-1', MALFORMED_LEAF_IDS[2]),
              payload: null
            },
            meta: { source: 'claude' }
          },
          {
            event: {
              paneKey: PANE_KEY,
              payload: {
                state: 'working',
                prompt: 'keep me after restart',
                agentType: 'codex'
              },
              reconcileDiagnostic: {
                kind: 'unverifiable',
                reason: 'transcript-unreadable',
                observedAt: 123
              }
            },
            meta: { source: 'codex', env: 'remote', version: '1' }
          }
        ]
      }),
      'utf8'
    )

    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await expect(server.start()).resolves.toBeUndefined()
    try {
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'codex',
          env: 'remote',
          version: '1',
          payload: expect.objectContaining({
            prompt: 'keep me after restart',
            agentType: 'codex'
          }),
          reconcileDiagnostic: {
            kind: 'unverifiable',
            reason: 'transcript-unreadable',
            observedAt: 123
          },
          isReplay: true
        })
      )
    } finally {
      server.stop()
    }
  })

  it('does not let an older spool record overwrite a newer durable status', async () => {
    const cachedAt = Date.now()
    writeFileSync(
      join(dir, 'hook-status-cache.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            event: {
              paneKey: PANE_KEY,
              payload: { state: 'working', prompt: 'newer cached turn', agentType: 'codex' }
            },
            meta: { source: 'codex', env: 'remote', version: '1', receivedAt: cachedAt }
          }
        ]
      }),
      'utf8'
    )
    const spoolDir = join(dir, 'spool')
    mkdirSync(spoolDir)
    writeFileSync(
      join(spoolDir, 'pane.jsonl'),
      `${JSON.stringify({
        paneKey: PANE_KEY,
        source: 'codex',
        hookEventName: 'Stop',
        payload: { hook_event_name: 'Stop' },
        receivedAt: cachedAt - 1
      })}\n`
    )
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })

    await server.start()
    try {
      expect(forward).not.toHaveBeenCalled()
      expect(server.replayCachedPayloadsForPanes()).toBe(1)
      expect(forward).toHaveBeenLastCalledWith(
        expect.objectContaining({
          isReplay: true,
          payload: expect.objectContaining({ state: 'working', prompt: 'newer cached turn' })
        })
      )
    } finally {
      server.stop()
    }
  })
})
