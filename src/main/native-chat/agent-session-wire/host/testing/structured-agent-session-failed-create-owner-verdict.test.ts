// Durable exit proof distinguishes safe new-operation retry from a possibly existing session.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../providers/testing/structured-agent-session-adapter-router-test-support'
import { claudeProfileSetupFailed } from '../../../../claude-accounts/claude-profile-launch-errors'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-failed-create-verdict-'))
  resetHostTestOperationIds()
  acquire = vi.fn(async ({ fence, spawnToken }) => ({
    acquisitionGeneration: globalThis.crypto.randomUUID(),
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: codexProviderHandle(THREAD),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: async () => ({
        reportedOptions: { model: '' }
      }),
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
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('failed create owner verdict', () => {
  it('returns a typed preparation failure on its first response and replay, then permits recovery', async () => {
    acquire.mockRejectedValueOnce(claudeProfileSetupFailed())
    const params = hostTestAttachParams(null)
    const first = await host.attach(CALLER, params)
    expect(first).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'claudeAccountSetupFailed', ownerVerdict: 'exited' },
        ownerVerdict: 'exited'
      }
    })
    await expect(host.attach(CALLER, params)).resolves.toEqual(first)
    await expect(host.attach(CALLER, hostTestAttachParams(null))).resolves.toMatchObject({
      ok: true
    })
  })
})
