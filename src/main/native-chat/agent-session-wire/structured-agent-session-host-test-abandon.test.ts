// The helper is what the restart specs remove their temp directory behind, so what it waits for is
// load-bearing: a store commit that lands afterwards re-creates the directory it just removed.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { abandonStructuredAgentSessionHost } from './structured-agent-session-host-test-abandon'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const CALLER = { callerKey: 'client-1' }

describe('abandoning a structured agent-session host', () => {
  it('waits for the restart the delivery loop woke for an accepted send', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-abandon-'))
    const store = await openTestAgentSessionRecordStore(root)
    // Holds the restart inside its provider acquisition, so the point teardown must not run past
    // is exact rather than a timing window.
    let gate: Promise<void> | null = null
    let openGate = (): void => {}
    let reportEntered = (): void => {}
    const entered = new Promise<void>((resolve) => {
      reportEntered = resolve
    })
    const adapter: StructuredAgentSessionAdapter = {
      acquire: async ({ fence }) => {
        if (gate) {
          reportEntered()
          await gate
        }
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: NOW - 1_000,
            spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
          },
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex', threadId: THREAD },
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }
      },
      dispatch: async () => ({
        state: 'accepted',
        providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
      }),
      cancelTurn: async () => ({ cancelled: true }),
      answerPrompt: async () => undefined,
      releaseAcquisition: async () => true,
      setOption: async () => undefined
    }
    const host = new StructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter,
      probeOwner: async () => ({
        outcome: 'identity-matched',
        matchedOn: ['process-start-time']
      }),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
    // The conversation stays and its provider child does not, so the next send makes the delivery
    // loop start one — the shape the refusal-oracle spec ends on.
    await host.close(SESSION, 'evict')
    gate = new Promise<void>((resolve) => {
      openGate = resolve
    })

    const body = hostTestMessage('delivery loop')
    expect(
      await host.send(CALLER, {
        envelope: {
          sessionId: SESSION,
          clientOperationId: `${NOW}-000000000000000000000000000003e9`,
          expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body }
          })
        },
        body
      })
    ).toMatchObject({ ok: true })
    await entered

    let abandoned = false
    const abandoning = abandonStructuredAgentSessionHost(host).then(() => {
      abandoned = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(abandoned).toBe(false)

    openGate()
    await abandoning

    // Nothing is left to put the directory back after this returns.
    await rm(root, { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(root)).toBe(false)
  })
})
