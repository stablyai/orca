// Every way a chat is created in a shared agent's Home names its tab's person before the chat exists,
// from its creator: a teammate's lands in their own list only, an unnamed one in no list, and the
// owner sees nothing of either.
import { afterEach, expect, it } from 'vitest'
import type { BotRequestAsker } from '../../../shared/bots/bot-acts-for'
import { startBotSession } from '../bot-chat-session'
import { createStructuredWorkerSessionForWorktree } from '../../runtime/rpc/methods/orchestration/worker/start/placement/worker-placement-topology'
import { savedIds } from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { ownerUntouchedBy } from './owner-untouched-by.test-support'
import { unnamedCreatorTabPerson } from './teammate-rules'
import { C, O, rig, settleTeammateRig, stubUserData, TEAMMATE } from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

type Rig = Awaited<ReturnType<typeof rig>>

const SLACK_LINKED_MATE: BotRequestAsker = {
  kind: 'person',
  source: 'slack',
  userId: 'U-mate',
  workspaceId: null,
  role: 'member',
  viaAccount: TEAMMATE.accountId
}

const bot = (r: Rig) => r.runtime.bots.list().find((entry) => entry.id === TEAMMATE.botId)!

/** A worker the way a dispatch places it: for its coordinator's person, else the unnamed rule. */
async function startWorker(r: Rig, coordinator: string | null) {
  stubUserData()
  const created = await createStructuredWorkerSessionForWorktree({
    runtime: r.runtime,
    worktreeId: r.workspace,
    agent: 'codex',
    dispatchId: `dispatch-${coordinator ?? 'none'}`,
    effects: [],
    person:
      (coordinator ? r.runtime.existingChatTabPerson(coordinator) : null) ??
      unnamedCreatorTabPerson(r.workspace, r.runtime.bots.list())
  })
  return created.identity.sessionId
}

it('opens a Slack-linked teammate’s bot chat in their own list, its host row unset', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  let sessionId = ''

  await ownerUntouchedBy(r, async () => {
    stubUserData()
    sessionId = await startBotSession(r.runtime, bot(r), {
      actsFor: { actsFor: [SLACK_LINKED_MATE] }
    })
  })

  expect(r.mine().chats).toEqual([sessionId])
  expect(r.mineSaved()).toEqual([sessionId])
  expect(await r.hostChats()).toEqual([O])
  expect(r.host.isSessionTabVisible(sessionId)).toBe(false)
})

it('opens the owner’s bot chat in the host’s list, as before', async () => {
  const r = await rig()
  stubUserData()

  const sessionId = await startBotSession(r.runtime, bot(r), {})

  expect(await r.hostChats()).toEqual([sessionId])
  expect(r.mine().chats).toEqual([])
  expect(r.host.isSessionTabVisible(sessionId)).toBe(true)
})

it('places a Home worker no chat here started in no one’s list, the owner’s left as it was', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  let sessionId = ''

  await ownerUntouchedBy(r, async () => {
    sessionId = await startWorker(r, null)
  })

  expect(r.mine().chats).not.toContain(sessionId)
  expect(r.mineSaved()).not.toContain(sessionId)
  expect(await r.hostChats()).toEqual([O])
  expect(savedIds(r)).toEqual([O])
  expect(r.host.isSessionTabVisible(sessionId)).toBe(false)
})

it('places a worker a teammate’s chat started in that teammate’s own list', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  let sessionId = ''

  await ownerUntouchedBy(r, async () => {
    sessionId = await startWorker(r, C)
  })

  expect(r.mine().chats).toEqual([C, sessionId])
  expect(r.mineSaved()).toEqual([C, sessionId])
  expect(r.host.isSessionTabVisible(sessionId)).toBe(false)
})
