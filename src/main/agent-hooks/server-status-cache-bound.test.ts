import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentHookServer,
  MAX_AGENT_HOOK_CONNECTION_TIMESTAMP_WATERMARKS,
  MAX_AGENT_HOOK_LAST_STATUS_FILE_BYTES
} from './server'
import { MAX_AGENT_HOOK_STATUS_CACHE_PANES } from '../../shared/agent-hook-status-cache'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function paneKey(index: number): string {
  return makePaneKey(`status-cache-${index}`, LEAF_ID)
}

function cachedStatus(
  index: number,
  state: AgentHookEventPayload['payload']['state'],
  receivedAt: number
): AgentHookEventPayload & { receivedAt: number; stateStartedAt: number } {
  return {
    paneKey: paneKey(index),
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    payload: { state, prompt: `prompt-${index}`, agentType: 'claude' }
  }
}

describe('AgentHookServer status cache bound', () => {
  it('evicts a completed row before fresh work and clears related state', () => {
    const server = new AgentHookServer()
    const listener = server._getStateForTests()
    const now = Date.now()
    for (let index = 0; index < MAX_AGENT_HOOK_STATUS_CACHE_PANES; index += 1) {
      const state = index === MAX_AGENT_HOOK_STATUS_CACHE_PANES - 1 ? 'done' : 'working'
      listener.lastStatusByPaneKey.set(paneKey(index), cachedStatus(index, state, now))
    }
    const completedPaneKey = paneKey(MAX_AGENT_HOOK_STATUS_CACHE_PANES - 1)
    listener.lastPromptByPaneKey.set(completedPaneKey, 'cached prompt')
    const onClear = vi.fn()
    server.setPaneStatusClearListener(onClear)

    const currentPaneKey = paneKey(MAX_AGENT_HOOK_STATUS_CACHE_PANES)
    server.ingestRemote(
      {
        paneKey: currentPaneKey,
        payload: { state: 'working', prompt: 'current', agentType: 'claude' }
      },
      'connection-1'
    )

    expect(listener.lastStatusByPaneKey.size).toBe(MAX_AGENT_HOOK_STATUS_CACHE_PANES)
    expect(listener.lastStatusByPaneKey.has(paneKey(0))).toBe(true)
    expect(listener.lastStatusByPaneKey.has(completedPaneKey)).toBe(false)
    expect(listener.lastStatusByPaneKey.has(currentPaneKey)).toBe(true)
    expect(listener.lastPromptByPaneKey.has(completedPaneKey)).toBe(false)
    expect(onClear).toHaveBeenCalledOnce()
    expect(onClear).toHaveBeenCalledWith({ paneKey: completedPaneKey })
  })

  it('evicts a stale hydrated row before older fresh work at capacity', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-status-cache-'))
    const endpointDir = join(userDataPath, 'agent-hooks')
    mkdirSync(endpointDir, { recursive: true })
    const now = Date.now()
    const entries: Record<string, ReturnType<typeof cachedStatus>> = {}
    for (let index = 0; index <= MAX_AGENT_HOOK_STATUS_CACHE_PANES; index += 1) {
      const receivedAt = index === 1 ? now - AGENT_STATUS_STALE_AFTER_MS - 1 : now
      entries[paneKey(index)] = cachedStatus(index, 'working', receivedAt)
    }
    writeFileSync(join(endpointDir, 'last-status.json'), JSON.stringify({ version: 2, entries }))
    const server = new AgentHookServer()

    try {
      await server.start({ env: 'production', userDataPath })
      const listener = server._getStateForTests()

      expect(listener.lastStatusByPaneKey.size).toBe(MAX_AGENT_HOOK_STATUS_CACHE_PANES)
      expect(listener.lastStatusByPaneKey.has(paneKey(0))).toBe(true)
      expect(listener.lastStatusByPaneKey.has(paneKey(1))).toBe(false)
      expect(listener.lastStatusByPaneKey.has(paneKey(MAX_AGENT_HOOK_STATUS_CACHE_PANES))).toBe(
        true
      )
    } finally {
      server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('bounds connection watermarks and refreshes recency before overflow', () => {
    const server = new AgentHookServer()
    const watermarks = (
      server as unknown as {
        connectionTimestampWatermarkById: Map<string, number>
      }
    ).connectionTimestampWatermarkById

    for (let index = 0; index < MAX_AGENT_HOOK_CONNECTION_TIMESTAMP_WATERMARKS; index += 1) {
      server.clearStatusEntriesForConnection(`connection-${index}`)
    }
    expect(watermarks.size).toBe(MAX_AGENT_HOOK_CONNECTION_TIMESTAMP_WATERMARKS)

    server.clearStatusEntriesForConnection('connection-0')
    server.clearStatusEntriesForConnection(
      `connection-${MAX_AGENT_HOOK_CONNECTION_TIMESTAMP_WATERMARKS}`
    )

    expect(watermarks.size).toBe(MAX_AGENT_HOOK_CONNECTION_TIMESTAMP_WATERMARKS)
    expect(watermarks.has('connection-0')).toBe(true)
    expect(watermarks.has('connection-1')).toBe(false)
    expect(watermarks.has(`connection-${MAX_AGENT_HOOK_CONNECTION_TIMESTAMP_WATERMARKS}`)).toBe(
      true
    )
  })

  it('persists the newest statuses without exceeding its own hydration ceiling', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-agent-status-file-bound-'))
    const server = new AgentHookServer()

    try {
      await server.start({ env: 'production', userDataPath })
      const listener = server._getStateForTests()
      const retainedMetadata = 'x'.repeat(64 * 1024)
      for (let index = 0; index < MAX_AGENT_HOOK_STATUS_CACHE_PANES; index += 1) {
        listener.lastStatusByPaneKey.set(paneKey(index), {
          ...cachedStatus(index, 'working', Date.now()),
          worktreeId: retainedMetadata
        })
      }

      server.flushStatusPersistSync()

      const path = join(userDataPath, 'agent-hooks', 'last-status.json')
      const persisted = JSON.parse(readFileSync(path, 'utf8')) as {
        entries: Record<string, unknown>
      }
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_AGENT_HOOK_LAST_STATUS_FILE_BYTES)
      expect(Object.keys(persisted.entries).length).toBeLessThan(MAX_AGENT_HOOK_STATUS_CACHE_PANES)
      expect(persisted.entries[paneKey(MAX_AGENT_HOOK_STATUS_CACHE_PANES - 1)]).toBeDefined()
    } finally {
      server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
