// The exit-side half of the attach's journal barrier.
//
// A takeover reaps the superseded provider child from inside `adapter.acquire`,
// and the reap journals what it saw — for Codex, the tombstone that ends the
// turn-lifecycle row. The sink is unbound by then, so those writes only buffer;
// rebinding re-queues them. The page the attach reports has to be read AFTER
// they land, or it still shows a turn this same attach just ended.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
/** Opened by the test that gates the replacement journal; released unconditionally
 *  so a failed assertion fails fast instead of stalling teardown on the gate. */
let releaseGate: (() => void) | null = null

beforeEach(async () => {
  releaseGate = null
  root = await mkdtemp(join(tmpdir(), 'orca-attach-drain-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex' as const, threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length
        ? ('resumed' as const)
        : ('created' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  releaseGate?.()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('attach journal barrier', () => {
  it('drains what the reaped child wrote during acquire before reporting the page', async () => {
    expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
    const released = await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })
    // Stands in for closing the superseded child: journaled from inside
    // `acquire`, while the sink is unbound and the write is only buffered.
    acquire.mockImplementationOnce(async (input) => {
      input.events?.appendItem(
        { provider: 'orca', clientMessageId: 'reaped-child-write' },
        { kind: 'status', text: 'reaped child write' }
      )
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: 'resumed-link',
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: 'resumed' as const,
          mintedAtFence: input.fence,
          observedAt: NOW
        }
      }
    })

    const sink = (
      host as unknown as {
        runtimeState: {
          eventSinkFor: (sessionId: string) => DeferredStructuredAgentSessionEventSink
        }
      }
    ).runtimeState.eventSinkFor(SESSION)
    const appendGate = Promise.withResolvers<void>()
    releaseGate = appendGate.resolve
    const bind = sink.bind.bind(sink)
    let bound = 0
    // Gate the replacement journal the instant the sink is re-pointed at it, so
    // the buffered write cannot land until this test lets it.
    sink.bind = (target) => {
      bound += 1
      const append = target.journal.appendItem.bind(target.journal)
      vi.spyOn(target.journal, 'appendItem').mockImplementationOnce(async (...args) => {
        await appendGate.promise
        return append(...args)
      })
      bind(target)
    }

    let settled = false
    const replacement = host.attach(CALLER, hostTestAttachParams(released.lease.runtimeFence))
    void replacement.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(bound).toBe(1))
    // All that is left after the bind is one store write and a page read, so an
    // attach that did not wait for the reaped child's write settles here. One
    // that does wait is parked on the drain until the gate opens below.
    await expect(
      vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000, interval: 5 })
    ).rejects.toThrow()

    appendGate.resolve()
    const attached = await replacement
    expect(attached).toMatchObject({ ok: true })
    if (!attached.ok) {
      throw new Error('attach refused')
    }
    const statuses = attached.value.page.items.flatMap((item) =>
      item.body.kind === 'status' ? [item.body.text] : []
    )
    expect(statuses).toContain('reaped child write')
  })
})
