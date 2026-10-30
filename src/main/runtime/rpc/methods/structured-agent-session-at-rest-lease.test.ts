import '../unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', { spy: true })
import { readFile } from 'node:fs/promises'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { REST_TEST_SESSION as SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStore
} from '../../agent-session-record-store-test-harness'

import { fixture, call, restingChat } from './structured-agent-session-rest-contract-test-fixture'

it('hands off a readable saved conversation without granting its invalid execution lease authority', async () => {
  await restingChat()
  const { cursor } = await fixture.rig.host.journalSnapshot(SESSION)
  await fixture.rig.host.flushAllStreamedEvents()
  await editPersistedTestAgentSessionStore(fixture.rig.root, (persisted) => {
    Object.assign(persisted.records[SESSION].lease, { minimumNextFence: 'bad' })
  })
  await fixture.rig.restart()
  setStructuredAgentSessionHost(fixture.rig.host)
  expect(fixture.rig.store.getRecord(SESSION)).toBeNull()
  expect(fixture.rig.store.getConversation(SESSION)?.location.workspaceId).toBe('workspace-1')
  const saved = (await readPersistedTestAgentSessionStore(fixture.rig.root)).records[SESSION]
  const params = { sessionId: SESSION, workspaceId: 'workspace-1', expectedCursor: cursor }
  const result = await fixture.rig.host.continuationContext(params)
  expect(result).toMatchObject({
    status: 'current',
    capturedText: expect.stringContaining('hello')
  })
  if (result.status !== 'current' || !result.transcriptPath) {
    throw new Error('Saved conversation snapshot missing')
  }
  expect(await readFile(result.transcriptPath, 'utf8')).toContain('hello')
  expect(await call('agentSession.continuationContext', params)).toMatchObject([
    { ok: true, result }
  ])
  for (const stale of [
    { ...params, workspaceId: 'other' },
    { ...params, expectedCursor: { ...cursor, epoch: 'other' } },
    { ...params, expectedCursor: { ...cursor, sequence: cursor.sequence + 1 } }
  ]) {
    expect(await fixture.rig.host.continuationContext(stale)).toEqual({ status: 'superseded' })
  }
  expect(fixture.rig.store.getRecord(SESSION)).toBeNull()
  expect((await readPersistedTestAgentSessionStore(fixture.rig.root)).records[SESSION]).toEqual(
    saved
  )
  expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  expect(fixture.rig.adapter.dispatch).not.toHaveBeenCalled()
})
