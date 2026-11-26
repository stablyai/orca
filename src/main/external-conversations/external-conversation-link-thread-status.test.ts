import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ThreadStatusFact } from '../../shared/connectors/external-conversation-link'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { parseExternalConversationLink } from './external-conversation-link-parser'
import { writeChatLink, writeLinkFact } from './external-conversation-link-writes'
import { findLink, writeLink } from './external-conversation-links'

const THREAD = { source: 'slack' as const, externalId: 'T1:C1:1.0:U0BOT' }
const bot = { kind: 'bot' as const, botId: 'bot-1' }
const fact: ThreadStatusFact = {
  seq: 3,
  day: '2026-11-26',
  dayCount: 3,
  armed: { at: 10, turnEndAt: 20, lastLineAt: 30, lastBotAt: 25, dueStep: 2 },
  pending: { replyId: 'status-x', text: 'Still working on this (5 h 30 min).', at: 40, stop: false }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-thread-status-fact-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

function home() {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  const workspace = { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }
  writeLink(store, workspace, {
    ...THREAD,
    sessionId: 'chat-1',
    agent: 'claude',
    paneKey: 'pane-1',
    bot,
    createdAt: 1
  })
  return { store, workspace }
}

it('keeps the status fact across a restart and a relink, and drops only a malformed one', async () => {
  const { store, workspace } = home()
  expect(writeLinkFact(store, THREAD, { threadStatus: fact })).toBe(true)
  // The same fact again changes nothing.
  expect(writeLinkFact(store, THREAD, { threadStatus: { ...fact } })).toBe(false)
  await store.flushPendingOrThrowAsync()
  await closeTestStores()

  const reopened = createStore()
  expect(findLink(reopened, THREAD)?.link.threadStatus).toEqual(fact)
  // The thread's chat changes: its numbering goes with it, so no reply id is reused.
  writeChatLink(reopened, THREAD, {
    worktreeId: workspace.worktreeId,
    sessionId: 'chat-2',
    agent: 'claude',
    bot
  })
  expect(findLink(reopened, THREAD)?.link).toMatchObject({
    sessionId: 'chat-2',
    threadStatus: fact
  })

  expect(writeLinkFact(reopened, THREAD, { threadStatus: undefined })).toBe(true)
  expect(findLink(reopened, THREAD)?.link).not.toHaveProperty('threadStatus')

  const link = { ...THREAD, sessionId: 's', agent: 'claude', paneKey: 'p', createdAt: 1 }
  expect(
    parseExternalConversationLink({ ...link, threadStatus: { ...fact, armed: { dueStep: 7 } } })
  ).toEqual(link)
})
