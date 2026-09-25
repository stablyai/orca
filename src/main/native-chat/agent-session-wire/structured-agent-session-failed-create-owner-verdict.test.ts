// A durably failed create tells a client what the host proved about the provider process, so a
// client can tell "retry under a new operation" (exited) from "the session may exist" (anything else).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestLaunchDirectory,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const EXIT_REASON = 'claude stream-json exited (code 1): stderr tail'

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
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      releaseAcquisition: vi.fn(async () => true),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    resolveLaunchDirectory: hostTestLaunchDirectory,
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('failed create owner verdict', () => {
  it('answers an exit-proven failure as exited on the first call and its replay, and a new operation starts fresh', async () => {
    // The cleanup's release proves the whole tree gone: the common failed start.
    acquire.mockRejectedValueOnce(new Error(EXIT_REASON))
    const first = hostTestAttachParams(null)
    const refusal = {
      code: 'agent_session_operation_invalid',
      message: EXIT_REASON,
      ownerVerdict: 'exited'
    }

    await expect(host.attach(CALLER, first)).resolves.toEqual({ ok: false, refusal })
    await expect(host.attach(CALLER, first)).resolves.toEqual({ ok: false, refusal })
    expect(acquire).toHaveBeenCalledOnce()

    const retry = hostTestAttachParams(null)
    expect(retry.envelope.clientOperationId).not.toBe(first.envelope.clientOperationId)
    await expect(host.attach(CALLER, retry)).resolves.toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  })

  it('answers a first-hand root exit as exited on the first call, in the shape its replay takes', async () => {
    acquire.mockRejectedValueOnce(
      new AgentSessionAcquisitionRootExitObservedError(new Error(EXIT_REASON))
    )
    const first = hostTestAttachParams(null)
    const refusal = {
      code: 'agent_session_operation_invalid',
      message: EXIT_REASON,
      ownerVerdict: 'exited'
    }

    await expect(host.attach(CALLER, first)).resolves.toEqual({ ok: false, refusal })
    await expect(host.attach(CALLER, first)).resolves.toEqual({ ok: false, refusal })
    expect(acquire).toHaveBeenCalledOnce()

    await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
      ok: true
    })
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('answers an acquisition refusal with its verdict directly', async () => {
    acquire.mockRejectedValueOnce(new AgentSessionAcquisitionRefusal('not signed in'))

    await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: 'not signed in',
        ownerVerdict: 'exited'
      }
    })
  })

  it('never claims exited when the failed attempt could not prove its process gone', async () => {
    acquire.mockRejectedValueOnce(new AgentSessionAcquisitionExitUnprovenError(new Error('hung')))
    const first = hostTestAttachParams(null)

    await expect(host.attach(CALLER, first)).rejects.toThrow()
    const replay = await host.attach(CALLER, first)

    expect(replay).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_ownership_unknown', ownerVerdict: 'unverifiable' }
    })
    expect(store.getRecord(SESSION)?.lease.claimStatus).not.toBe('released')
  })
})
