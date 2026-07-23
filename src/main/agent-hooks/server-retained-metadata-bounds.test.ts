import { describe, expect, it, vi } from 'vitest'
import {
  AgentHookServer,
  MAX_AGENT_HOOK_RETAINED_ID_UTF8_BYTES,
  MAX_AGENT_HOOK_RETAINED_PATH_UTF8_BYTES
} from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const PANE_KEY = makePaneKey('metadata-bounds-tab', '11111111-1111-4111-8111-111111111111')

describe('AgentHookServer retained metadata bounds', () => {
  it('preserves every metadata field at its exact UTF-8 byte limit', () => {
    const server = new AgentHookServer()
    const exactId = 'é'.repeat(MAX_AGENT_HOOK_RETAINED_ID_UTF8_BYTES / 2)
    const exactPath = 'é'.repeat(MAX_AGENT_HOOK_RETAINED_PATH_UTF8_BYTES / 2)

    expect(Buffer.byteLength(exactId, 'utf8')).toBe(MAX_AGENT_HOOK_RETAINED_ID_UTF8_BYTES)
    expect(Buffer.byteLength(exactPath, 'utf8')).toBe(MAX_AGENT_HOOK_RETAINED_PATH_UTF8_BYTES)

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'metadata-bounds-tab',
        worktreeId: exactPath,
        launchToken: exactId,
        promptInteractionKey: exactId,
        hookEventName: exactId,
        toolUseId: exactId,
        toolAgentId: exactId,
        toolAgentType: exactId,
        providerSession: {
          key: 'session_id',
          id: 'session-1',
          transcriptPath: exactPath
        },
        payload: { state: 'working', prompt: 'ordinary prompt', agentType: 'claude' }
      },
      exactId
    )

    const retained = server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)
    expect(retained).toMatchObject({
      launchToken: exactId,
      worktreeId: exactPath,
      connectionId: exactId,
      promptInteractionKey: exactId,
      hookEventName: exactId,
      toolUseId: exactId,
      toolAgentId: exactId,
      toolAgentType: exactId,
      providerSession: {
        key: 'session_id',
        id: 'session-1',
        transcriptPath: exactPath
      }
    })
  })

  it('omits optional metadata one byte over its limit', () => {
    const server = new AgentHookServer()
    const oversizedId = `${'é'.repeat(MAX_AGENT_HOOK_RETAINED_ID_UTF8_BYTES / 2)}x`
    const oversizedPath = `${'é'.repeat(MAX_AGENT_HOOK_RETAINED_PATH_UTF8_BYTES / 2)}x`

    expect(Buffer.byteLength(oversizedId, 'utf8')).toBe(MAX_AGENT_HOOK_RETAINED_ID_UTF8_BYTES + 1)
    expect(Buffer.byteLength(oversizedPath, 'utf8')).toBe(
      MAX_AGENT_HOOK_RETAINED_PATH_UTF8_BYTES + 1
    )

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'metadata-bounds-tab',
        worktreeId: oversizedPath,
        launchToken: oversizedId,
        promptInteractionKey: oversizedId,
        hookEventName: oversizedId,
        toolUseId: oversizedId,
        toolAgentId: oversizedId,
        toolAgentType: oversizedId,
        providerSession: {
          key: 'session_id',
          id: 'session-1',
          transcriptPath: oversizedPath
        },
        payload: { state: 'working', prompt: 'ordinary prompt', agentType: 'claude' }
      },
      'connection-1'
    )

    const retained = server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)
    expect(retained).toMatchObject({
      connectionId: 'connection-1',
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    expect(retained).not.toHaveProperty('providerSession.transcriptPath')
    for (const field of [
      'launchToken',
      'worktreeId',
      'promptInteractionKey',
      'hookEventName',
      'toolUseId',
      'toolAgentId',
      'toolAgentType'
    ]) {
      expect(retained?.[field as keyof typeof retained]).toBeUndefined()
    }
  })

  it('rejects oversized connection authority without retaining a watermark', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    const oversizedConnectionId = 'x'.repeat(MAX_AGENT_HOOK_RETAINED_ID_UTF8_BYTES + 1)
    server.setPaneStatusClearListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        payload: { state: 'working', prompt: 'ordinary prompt', agentType: 'claude' }
      },
      oversizedConnectionId
    )
    server.clearStatusEntriesForConnection(oversizedConnectionId)

    expect(server.getStatusSnapshot()).toEqual([])
    expect(
      (
        server as unknown as {
          connectionTimestampWatermarkById: Map<string, number>
        }
      ).connectionTimestampWatermarkById
    ).toHaveLength(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('rejects a path-dependent Pi identity when its transcript path is oversized', () => {
    const server = new AgentHookServer()

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: 'x'.repeat(MAX_AGENT_HOOK_RETAINED_PATH_UTF8_BYTES + 1)
        },
        providerSessionOnly: true,
        payload: { state: 'done', prompt: '', agentType: 'pi' }
      },
      'connection-1'
    )

    expect(server.getStatusSnapshot()).toEqual([])
  })
})
