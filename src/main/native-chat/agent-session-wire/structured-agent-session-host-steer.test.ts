import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

it('dispatches steer against the active turn without sending another turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-wire-host-steer-'))
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const dispatch = vi.fn(async () => ({ state: 'unknown' as const, reason: 'unexpected send' }))
  const steer = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
  }))
  const adapter: StructuredAgentSessionAdapter = {
    acquire: vi.fn(async ({ fence, events }) => {
      events?.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 },
        { kind: 'status', text: 'working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
        { lifecycle: true }
      )
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
        },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: 'created' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    }),
    dispatch,
    steer,
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined)
  }
  const host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  resetHostTestOperationIds()

  try {
    expect((await host.attach({ callerKey: 'client-1' }, hostTestAttachParams(null))).ok).toBe(true)
    await host.flushStreamedEvents(SESSION)
    const body = hostTestMessage('change course')
    const result = await host.steer(
      { callerKey: 'client-1' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.steer',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      }
    )
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(steer).toHaveBeenCalledWith(
      expect.objectContaining({ body, turnId: 'turn-1', fence: 1 })
    )
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    await host.flushAllStreamedEvents()
    await rm(root, { recursive: true, force: true })
  }
})
