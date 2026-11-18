import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import {
  openTestAgentSessionDatabase,
  openTestAgentSessionRecordStore
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import {
  NO_STRUCTURED_AGENTS,
  structuredAgentsDeclaringNothing
} from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { admitStructuredAgentSessionInput } from '../../delivery/structured-agent-session-input-admission'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data.test-fixture'
import { structuredAgentRuntimeRegistration } from '../../../../runtime/agent-session/installation/structured-agent-runtime-registrations'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
const CALLER = { callerKey: 'client-1' }
/** What the bot wiring would answer: the tools file changed, or Orca itself changed the tools. */
let tools: { changed: boolean; outdated: boolean }
let workOwed: boolean
let onDispatch: () => void
const dispatched: { clientMessageId: string; fence: number }[] = []

const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async ({ fence, spawnToken }) => {
  // A launch reads the tools as they are now.
  tools = { changed: false, outdated: false }
  return {
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    acquisitionGeneration: `generation-${fence}`,
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: fence === 1 ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
  }
})
const closeSession = vi.fn(async () => true)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-launch-tools-refresh-'))
  resetHostTestOperationIds()
  tools = { changed: false, outdated: false }
  workOwed = false
  onDispatch = () => {}
  dispatched.length = 0
  acquire.mockClear()
  closeSession.mockClear()
  const openCode = structuredAgentRuntimeRegistration('opencode')
  if (!openCode) {
    throw new Error('OpenCode is not registered')
  }
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: structuredAgentsDeclaringNothing([
      ...NO_STRUCTURED_AGENTS.definitions(),
      openCode.definition
    ]),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire,
      // Like the Claude and Codex adapters: the write happens inside the host's admission.
      dispatch: vi.fn(async (input) => {
        await admitStructuredAgentSessionInput(input.admitFreshInput, () => {
          dispatched.push({ clientMessageId: input.clientMessageId, fence: input.fence })
          onDispatch()
        })
        return {
          state: 'accepted' as const,
          providerIdentity: {
            provider: 'codex' as const,
            threadId: THREAD,
            turnId: 't',
            ordinal: 1
          }
        }
      }),
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined),
      open: async () => ({ reportedOptions: { model: '' } })
    },
    journalDatabase: await openTestAgentSessionDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    hasOpenDispatch: () => workOwed,
    launchTools: {
      changed: async () => tools.changed,
      outdated: () => tools.outdated
    },
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const envelope = {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: SESSION,
      fields: { body }
    })
  }
  expect(await host.send(CALLER, { envelope, body })).toMatchObject({ ok: true })
  return envelope.clientOperationId
}

async function delivered(id: string): Promise<{ clientMessageId: string; fence: number }> {
  await vi.waitFor(() => expect(dispatched.some((d) => d.clientMessageId === id)).toBe(true), {
    timeout: 10_000
  })
  return dispatched.find((d) => d.clientMessageId === id)!
}

async function started(): Promise<number> {
  const id = await send('first')
  return (await delivered(id)).fence
}

it('starts a new agent for the next turn when the tools file changed since launch', async () => {
  const first = await started()
  const launches = acquire.mock.calls.length
  tools.changed = true

  const next = await delivered(await send('use the new tool'))

  expect(acquire).toHaveBeenCalledTimes(launches + 1)
  expect(next.fence).toBeGreaterThan(first)
})

it('hands the same unwritten send to a new agent when Orca changed the tools after preparing it', async () => {
  const first = await started()
  const launches = acquire.mock.calls.length
  // Only the no-I/O check sees it, as for a change made between preparation and the write.
  tools.outdated = true

  const id = await send('use the new tool')
  const next = await delivered(id)

  expect(acquire).toHaveBeenCalledTimes(launches + 1)
  expect(next.fence).toBeGreaterThan(first)
  expect(dispatched.filter((d) => d.clientMessageId === id)).toHaveLength(1)
})

it('keeps the agent while it owes work, and refreshes once the work is done', async () => {
  const first = await started()
  const launches = acquire.mock.calls.length
  workOwed = true
  tools.changed = true
  tools.outdated = true

  const kept = await delivered(await send('while a worker runs'))
  expect(kept.fence).toBe(first)
  expect(acquire).toHaveBeenCalledTimes(launches)

  workOwed = false
  const next = await delivered(await send('after the worker'))
  expect(next.fence).toBeGreaterThan(first)
  expect(acquire).toHaveBeenCalledTimes(launches + 1)
})

it('never sends a written message again when the tools change during its write', async () => {
  await started()
  const launches = acquire.mock.calls.length
  onDispatch = () => {
    tools.outdated = true
    tools.changed = true
  }

  const id = await send('changes tools while it is written')
  await delivered(id)
  await host.flushAllStreamedEvents()

  expect(dispatched.filter((d) => d.clientMessageId === id)).toHaveLength(1)
  expect(acquire).toHaveBeenCalledTimes(launches)
})
