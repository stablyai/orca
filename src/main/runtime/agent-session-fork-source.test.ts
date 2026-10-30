import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { reserveRequestFor } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import {
  hostTestAttachParams,
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'

let directory: string | undefined

afterEach(async () => {
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('persists branch lineage without requiring a retained parent record or tab', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-fork-source-'))
  const store = await openTestAgentSessionRecordStore(directory)
  const forkedFrom = { sessionId: 'codex_closed_parent', itemId: 'assistant-b' }
  const params = hostTestAttachParams(null, {
    forkedFrom,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    }
  })
  const request = reserveRequestFor({
    sessionId: SESSION,
    params,
    authority: {
      spawnToken: 'unused',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'pid-absent' }
    },
    callerKey: 'client-1',
    fingerprint: params.envelope.payloadFingerprint,
    now: NOW
  })
  await store.founding.commit(request)
  const reopened = await openTestAgentSessionRecordStore(directory)
  expect(reopened.getRecord(SESSION)?.forkedFrom).toEqual(forkedFrom)
  expect(reopened.getConversation(SESSION)?.forkedFrom).toEqual(forkedFrom)
  expect(reopened.getRecord(forkedFrom.sessionId)).toBeNull()
  expect((await reopened.founding.commit(request)).disposition).toBe('replayed')
})
