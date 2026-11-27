// Anyone on a shared agent watches anyone's tab list in its Home, live. Watching writes nothing to any
// list, any device's focus or the owner's read marks; closing a tab in a watched list is its one write.
// Through the real dispatcher, runtime, chat host and record store.
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { physicalReload } from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import {
  B,
  C,
  O,
  OTHER,
  rig,
  sessions,
  settleTeammateRig,
  TEAMMATE,
  type Tabs
} from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

const MATE = { accountId: TEAMMATE.accountId }

/** Everything a rig's lists and device picks hold, byte for byte, beside the owner's view. */
async function everyonesTabs(r: Awaited<ReturnType<typeof rig>>): Promise<string> {
  return JSON.stringify({
    owner: await r.ownerView(),
    mate: [await r.list('mate-desk'), await r.list('mate-phone')].map(
      ({ agentSenderAssociations: _senders, ...tabs }) => tabs
    ),
    other: await r.list('other-desk'),
    picks: r.runtime['clientSessionTabSelections'].serialize(),
    lists: r.runtime['personSessionTabs'].serialize()
  })
}

it('streams each person’s list to whoever watches it, live, and watching writes nothing', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  await r.activate('mate-desk', C)
  const before = await everyonesTabs(r)

  const mateWatchesOwner = await r.subscribe('mate-desk', false, 'owner')
  const ownerWatchesMate = await r.subscribe('owner-desk', false, MATE)
  expect(sessions(mateWatchesOwner.at(-1)!)).toEqual([O])
  expect(sessions(ownerWatchesMate.at(-1)!)).toEqual([C])
  // Another teammate reads both, and an empty list of their own.
  expect(sessions(await r.list('other-desk', undefined, 'owner'))).toEqual([O])
  expect(sessions(await r.list('other-desk', undefined, MATE))).toEqual([C])
  expect(sessions(await r.list('other-desk'))).toEqual([])
  await chatTabCommandsSettled()
  expect(await everyonesTabs(r)).toBe(before)

  // Each list's change reaches its watchers; the other watched list stays as it was.
  await r.reveal('owner-desk', B)
  await vi.waitFor(() => expect(sessions(mateWatchesOwner.at(-1)!)).toEqual([O, B]))
  expect(sessions(ownerWatchesMate.at(-1)!)).toEqual([C])
  await r.reveal('mate-desk', B)
  await vi.waitFor(() => expect(sessions(ownerWatchesMate.at(-1)!)).toEqual([C, B]))
  expect(sessions(mateWatchesOwner.at(-1)!)).toEqual([O, B])
})

it('closes a tab only in the list a viewer watches', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('other-desk', C)
  await r.reveal('mate-desk', B)
  const owner = await r.ownerView()
  const mateOwn = async () => {
    const { agentSenderAssociations: _senders, ...tabs } = await r.list('mate-desk')
    return tabs
  }
  const mates = await mateOwn()

  // Mate closes Other's tab from Other's list.
  await r.call('mate-desk', 'session.tabs.close', {
    worktree: `id:${r.workspace}`,
    tabId: `agent-session:${C}`,
    reason: 'user',
    person: { accountId: OTHER.accountId }
  })
  await chatTabCommandsSettled()
  expect(sessions(await r.list('other-desk'))).toEqual([])
  expect(await r.ownerView()).toBe(owner)
  expect(await mateOwn()).toEqual(mates)

  // Mate closes the owner's tab from the owner's list: the owner's list loses it, Mate's own keeps B.
  const ownersTab = (await r.list('mate-desk', undefined, 'owner')).tabs.find(
    (tab) => tab.sessionId === O
  )!
  await r.call('mate-desk', 'session.tabs.close', {
    worktree: `id:${r.workspace}`,
    tabId: ownersTab.id,
    reason: 'user',
    person: 'owner'
  })
  await chatTabCommandsSettled()
  expect(await r.hostChats()).toEqual([])
  expect(sessions(await r.list('owner-desk'))).toEqual([])
  expect(await mateOwn()).toEqual(mates)
})

it('keeps the owner’s tab when a teammate’s first call after a start opens the owner’s chat', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)

  const fresh = await rig({ opened: await physicalReload(r, { restore: false }) })
  // Before the host's tabs are restored: the owner's list must not lose O to the teammate's open.
  await fresh.reveal('mate-desk', O)
  await chatTabCommandsSettled()

  expect(await fresh.hostChats()).toEqual([O])
  expect(sessions(await fresh.list('owner-desk'))).toEqual([O])
  expect(fresh.host.isSessionTabVisible(O)).toBe(true)
  expect(sessions(await fresh.list('mate-desk'))).toEqual([O])
})

it('leaves the owner’s read marks to the owner when a teammate opens and reads a chat', async () => {
  const r = await rig()
  // The two writers of the owner's marks: a thread's "new" and notification attention.
  const seen = vi.spyOn(r.runtime, 'markBotThreadSeen')
  const acknowledged = vi.spyOn(r.runtime, 'acknowledgeNotificationAttention')
  const read = (deviceId: string) =>
    r.call(deviceId, 'agentSession.acknowledgeAttention', {
      sessionId: O,
      observedCursor: { epoch: 'epoch-1', sequence: 1 }
    })

  await r.reveal('mate-desk', O)
  await read('mate-desk')
  expect(seen).not.toHaveBeenCalled()
  expect(acknowledged).not.toHaveBeenCalled()

  await r.reveal('owner-desk', O)
  await read('owner-desk')
  expect(seen).toHaveBeenCalledWith(O)
  expect(acknowledged).toHaveBeenCalledTimes(1)
})

it('lists a teammate every chat of the agent, each by whose it is, with their own Home as Home', async () => {
  const r = await rig()
  const tree = z
    .object({
      chats: z.array(
        z.looseObject({
          chatId: z.string(),
          person: z.looseObject({ accountId: z.string() }).optional()
        })
      )
    })
    .parse(await r.call('mate-desk', 'bots.chatTree', { botId: TEAMMATE.botId }))
  const byId = new Map(tree.chats.map((chat) => [chat.chatId, chat]))
  // B and C act for Mate; O is the owner's, unmarked.
  expect(byId.get(C)?.person).toMatchObject(MATE)
  expect(byId.has(O)).toBe(true)
  expect(byId.get(O)?.person).toBeUndefined()
})

it('pins each person’s own Home in their list, never another person’s Home', async () => {
  const r = await rig()
  const bot = r.runtime.bots.list()[0]!
  // O is the owner's Home, C Mate's.
  r.profile.saveBot({
    ...bot,
    chatSessionId: O,
    shares: bot.shares?.map((share) =>
      share.kind === 'account' && share.accountId === TEAMMATE.accountId
        ? { ...share, homeSessionId: C }
        : share
    )
  })
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', O)
  await r.reveal('mate-desk', C)
  const pinned = (tabs: Tabs) =>
    tabs.tabs.flatMap((tab) => (tab.isPinned === true && tab.sessionId ? [tab.sessionId] : []))

  expect(pinned(await r.list('owner-desk'))).toEqual([O])
  expect(pinned(await r.list('mate-desk'))).toEqual([C])
  // Watched, each list pins its own person's Home.
  expect(pinned(await r.list('mate-desk', undefined, 'owner'))).toEqual([O])
  expect(pinned(await r.list('owner-desk', undefined, MATE))).toEqual([C])
})
