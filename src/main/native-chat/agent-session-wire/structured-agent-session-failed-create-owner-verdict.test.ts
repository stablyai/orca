// A failed first start says what the host proved about the provider process, so a reader can tell
// "the next start goes ahead" (exited) from "the process may still exist" (anything else).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { attachForTests, startAgentForTests } from './structured-agent-session-attach-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'claude stream-json exited (code 1): stderr tail'
// The refusal says what the chat's start failure says; the error text stays in the log.
const COULD_NOT_START = "Codex couldn't start. Send your message to try again."
const PROVIDER_STOPPED =
  'Codex stopped before it finished starting. Send your message to try again.'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-failed-create-verdict-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('failed first start owner verdict', () => {
  it.each([
    // The cleanup's release proves the whole tree gone, which says nothing about why it failed.
    ['a failure the cleanup proved gone', () => new Error(EXIT_REASON), {}, COULD_NOT_START],
    // Only an exit the adapter saw says the provider stopped.
    [
      'an exit the adapter observed',
      () => withObservedProviderExit(new Error(EXIT_REASON)),
      { reason: 'providerStartFailed' },
      PROVIDER_STOPPED
    ]
  ])(
    'answers %s as exited, and the next start goes ahead',
    async (_case, failure, situation, message) => {
      acquire.mockRejectedValueOnce(failure())
      // The verdict reaches released clients at the top level exactly as before.
      const refusal = {
        code: 'agent_session_operation_invalid',
        details: { ...situation, ownerVerdict: 'exited' },
        message,
        ownerVerdict: 'exited'
      }

      await expect(attachForTests(host, CALLER, hostTestAttachParams(null))).resolves.toEqual({
        ok: false,
        refusal
      })
      expect(acquire).toHaveBeenCalledOnce()

      await expect(startAgentForTests(host, SESSION)).resolves.toMatchObject({ ok: true })
      expect(acquire).toHaveBeenCalledTimes(2)
      expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    }
  )

  it.each([
    // A cleanup that saw the root go may have stopped it itself.
    ['a root exit the cleanup saw', () => new Error(EXIT_REASON), {}, COULD_NOT_START],
    [
      'a root exit the adapter observed',
      () => withObservedProviderExit(new Error(EXIT_REASON)),
      { reason: 'providerStartFailed' },
      PROVIDER_STOPPED
    ]
  ])(
    'answers %s as exited, and the next start goes ahead',
    async (_case, cause, situation, message) => {
      acquire.mockRejectedValueOnce(new AgentSessionAcquisitionRootExitObservedError(cause()))
      const refusal = {
        code: 'agent_session_operation_invalid',
        details: { ...situation, ownerVerdict: 'exited' },
        message,
        ownerVerdict: 'exited'
      }

      await expect(attachForTests(host, CALLER, hostTestAttachParams(null))).resolves.toEqual({
        ok: false,
        refusal
      })
      expect(acquire).toHaveBeenCalledOnce()

      await expect(startAgentForTests(host, SESSION)).resolves.toMatchObject({ ok: true })
      expect(acquire).toHaveBeenCalledTimes(2)
    }
  )

  it('answers an acquisition refusal with its verdict directly', async () => {
    acquire.mockRejectedValueOnce(new AgentSessionAcquisitionRefusal('not signed in'))

    await expect(attachForTests(host, CALLER, hostTestAttachParams(null))).resolves.toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'providerStartFailed', ownerVerdict: 'exited' },
        message: PROVIDER_STOPPED,
        ownerVerdict: 'exited'
      }
    })
  })

  it('never claims exited when the failed attempt could not prove its process gone', async () => {
    acquire.mockRejectedValueOnce(new AgentSessionAcquisitionExitUnprovenError(new Error('hung')))
    const answer = await attachForTests(host, CALLER, hostTestAttachParams(null))

    expect(answer).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown', ownerVerdict: 'unverifiable' }
    })
    // Released so the next start can go ahead, but with no death evidence: nothing proved it.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: null
    })
  })
})
