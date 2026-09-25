// A host that dies while its Codex child is still starting leaves a lease behind. The child's
// identity is committed the moment it spawns, before the handshake, so the next host can stop that
// exact process and start over instead of guessing whether anything is running.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { openCodexAppServerConnection } from '../../codex/codex-app-server-connection'
import { adapterFor, fakeCodex } from '../../codex/codex-structured-session-adapter-fixture'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }
const CHILD_PID = 4321

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-crash-mid-start-'))
  resetHostTestOperationIds()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function openStore(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
}

/** A Codex adapter whose child spawns, reports its pid the way the real connection does, and then
 *  never answers the thread handshake: the host dies in that window. */
function adapterThatNeverFinishesStarting(): StructuredAgentSessionAdapter {
  const codex = fakeCodex({
    'thread/start': () => new Promise(() => {}),
    'thread/resume': () => new Promise(() => {})
  })
  const openConnection = (async (launch, handlers = {}) => {
    const connection = await codex.openConnection(launch, handlers)
    await handlers.onSpawned?.(CHILD_PID)
    return connection
  }) as typeof openCodexAppServerConnection
  return Object.assign(adapterFor({ ...codex, openConnection }), { supportsCreate: () => true })
}

function host(
  store: AgentSessionRecordStore,
  adapter: StructuredAgentSessionAdapter,
  overrides: Partial<StructuredAgentSessionHostDeps> = {}
): StructuredAgentSessionHost {
  return new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW,
    ...overrides
  })
}

describe('a host that dies while its Codex child is starting', () => {
  it('leaves the spawned child recorded, so the next host stops it by identity and starts over', async () => {
    const first = await openStore()
    const dying = host(first, adapterThatNeverFinishesStarting())
    void dying.attach(CALLER, hostTestAttachParams(null))
    await vi.waitFor(() => expect(first.getRecord(SESSION)?.lease.ownerProcess).toBeTruthy())
    // Durable before the handshake returned: the only record the next host will have.
    expect(first.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      ownerProcess: { pid: CHILD_PID, spawnToken: 'spawn-a' }
    })

    // The relaunch. The orphan is still alive until something stops it.
    let orphanAlive = true
    const stopOwnerProcess = vi.fn(() => {
      orphanAlive = false
    })
    const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(
      async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 5555, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex', threadId: 'thread-after-restart' },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      })
    )
    const store = await openStore()
    const relaunched = host(
      store,
      {
        acquire,
        releaseAcquisition: vi.fn(async () => true),
        dispatch: vi.fn(),
        cancelTurn: vi.fn(),
        answerPrompt: vi.fn(),
        setOption: vi.fn(),
        supportsCreate: () => true
      } as unknown as StructuredAgentSessionAdapter,
      {
        mintSpawnToken: () => 'spawn-b',
        probeOwner: async () =>
          orphanAlive
            ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
            : { outcome: 'pid-absent' },
        stopOwnerProcess
      }
    )
    await relaunched.restoreReadableSessions()

    expect(stopOwnerProcess).toHaveBeenCalledWith(CHILD_PID, 'SIGTERM')
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      ownerProcess: null,
      deathEvidence: { kind: 'pid-absent' }
    })
    await relaunched.hold(SESSION, 'desktop-chat:1')
    expect(acquire).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      ownerProcess: { pid: 5555, spawnToken: 'spawn-b' }
    })
  })
})
