// A quit drains a create still in flight before it closes conversations, as it drains a start.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

it('closes the conversation a create opened while the quit waited for it', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-create-drained-at-quit-'))
  const journalOpening = Promise.withResolvers<void>()
  const releaseJournalOpen = Promise.withResolvers<string | null>()
  const adapter: StructuredAgentSessionAdapter = {
    acquire: vi.fn(),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn(),
    historyFilePath: () => {
      journalOpening.resolve()
      return releaseJournalOpen.promise
    }
  }
  const host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(root),
    adapter,
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    now: () => NOW
  })

  const created = host.create({ callerKey: 'client-1' }, hostTestAttachParams(null))
  // Past the record's commit, opening the chat's journal.
  await journalOpening.promise
  let quitFinished = false
  const quit = host.flushAllStreamedEvents().then(() => {
    quitFinished = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(quitFinished).toBe(false)

  releaseJournalOpen.resolve(null)
  expect(await created).toMatchObject({ ok: true })
  await quit
  expect(host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
  expect(adapter.acquire).not.toHaveBeenCalled()
})
