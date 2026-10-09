// A chat starts whatever the store stamped on its owner: the Orca runtime holding the process is
// recorded beside its identity, and the start compares the process, not the stamp.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { agentSessionRuntimeIncarnation } from '../../runtime/agent-session-runtime-attribution'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const NOW = 1_800_000_000_000
const SESSION = 'stamped-owner-session'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function attachParams(): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

it('starts a chat whose recorded owner carries the runtime stamp', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stamped-owner-'))
  const store = await openTestAgentSessionRecordStore(root)
  // The record as the store published it, stamp included, rather than the transition's own copy.
  const commit = store.commitProcessIdentity.bind(store)
  vi.spyOn(store, 'commitProcessIdentity').mockImplementation(async (input) => {
    await commit(input)
    const published = store.getRecord(input.sessionId)
    if (!published) {
      throw new Error('the committed record is missing')
    }
    return published
  })
  const adapter: StructuredAgentSessionAdapter = {
    acquire: vi.fn<StructuredAgentSessionAdapter['acquire']>(
      async ({ fence, spawnToken, onSpawned }) => {
        const process = { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken }
        await onSpawned?.(process)
        return {
          process,
          link: {
            linkId: 'created-link',
            handle: codexProviderHandle('thread-1'),
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }
      }
    ),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }

  const attached = await performAttach({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter,
    openConversation: openTestAttachConversation(openTestJournalHostDatabase(root)),
    authority: {
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: OPERATION,
      probe: { outcome: 'reservation-unused' }
    },
    callerKey: 'client-1',
    optionRevision: () => 0,
    params: attachParams(),
    now: () => NOW,
    onAttached: () => {}
  })

  expect(attached).toMatchObject({ ok: true })
  expect(store.getRecord(SESSION)?.lease.ownerProcess).toMatchObject({
    pid: 4242,
    runtime: agentSessionRuntimeIncarnation()
  })
})
