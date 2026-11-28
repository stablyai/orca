// Anyone on a shared agent watches anyone's tab list in its Home, live. Watching writes nothing to any
// list, any device's focus or the owner's read marks; closing a tab in a watched list is its one write.
// Through the real dispatcher, runtime, chat host and record store.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { BOT_HOME_NAME, ownerHomeName } from '../../../shared/bots/bot-home-of'
import { HOME_CHAT_TITLE } from '../../../shared/bots/bot-chat-tree-model'
import { NO_HOME_CHAT_ID } from '../../../shared/bots/bot-chat-tree-homes'
import { sessionTabPaneKey } from '../../../shared/remote-runtime/session-graph/session-tab-pane-key'
import type { TabListPerson } from './teammate-rules'
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
  expect(fresh.mine().chats).toEqual([O])
})

it('leaves the owner’s read marks to the owner when a teammate opens and reads a chat', async () => {
  const r = await rig()
  // O came from a linked thread the owner has not opened yet: it shows as new.
  r.profile.updateFolderWorkspace(r.folderId, {
    externalConversations: [
      {
        source: 'slack',
        externalId: 'C1:1',
        sessionId: O,
        agent: 'codex',
        paneKey: O,
        createdAt: 1,
        seenAt: null
      }
    ]
  })
  const threadIsNew = () =>
    r.profile.getFolderWorkspace(r.folderId)?.externalConversations?.[0]?.seenAt === null
  const acknowledged = vi.fn()
  r.runtime.onClientEvent((event) => {
    if (event.type === 'notificationAttentionAcknowledged') {
      acknowledged()
    }
  })
  const read = (deviceId: string) =>
    r.call(deviceId, 'agentSession.acknowledgeAttention', {
      sessionId: O,
      observedCursor: { epoch: 'epoch-1', sequence: 1 }
    })

  await r.reveal('mate-desk', O)
  await read('mate-desk')
  expect(threadIsNew()).toBe(true)
  expect(acknowledged).not.toHaveBeenCalled()

  await r.reveal('owner-desk', O)
  await read('owner-desk')
  expect(threadIsNew()).toBe(false)
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
  // Mate's Home is not made yet: its row still says it is theirs.
  expect(byId.get(NO_HOME_CHAT_ID)?.person).toMatchObject(MATE)
})

it('finds every chat for a teammate’s search, with Homes named as their tree names them', async () => {
  const r = await rig()
  const bot = r.runtime.bots.list()[0]!
  r.profile.saveBot({
    ...bot,
    chatSessionId: O,
    shares: bot.shares?.map((share) =>
      share.kind === 'account' && share.accountId === TEAMMATE.accountId
        ? { ...share, homeSessionId: C }
        : share
    )
  })
  const Found = z.object({
    chats: z.array(z.looseObject({ chatId: z.string(), title: z.string() }))
  })
  const search = async (deviceId: string) =>
    Object.fromEntries(
      Found.parse(
        await r.call(deviceId, 'bots.chats.search', { botId: TEAMMATE.botId, query: 'Home' })
      ).chats.map((chat) => [chat.chatId, chat.title])
    )
  // Each reader's own Home is their Home Chat, the owner's by the owner's name to a teammate; one
  // reader's search, read within the same tree read, never answers another's.
  expect(await search('mate-desk')).toMatchObject({
    [C]: HOME_CHAT_TITLE,
    [O]: ownerHomeName(null)
  })
  expect(await search('owner-desk')).toMatchObject({ [O]: HOME_CHAT_TITLE })
})

it('marks the host’s unread chats only on an owner’s phone reading its own list', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', O)
  const shown = (await r.list('owner-desk')).tabs.find((tab) => tab.sessionId === O)
  const paneKey = sessionTabPaneKey(
    z.looseObject({ type: z.string(), id: z.string() }).parse(shown)
  )
  const unreadIn = (frames: Tabs[]) =>
    frames.at(-1)!.tabs.flatMap((tab) => (tab.unread === true ? [tab.sessionId] : []))
  const ownersStream = await r.subscribe('owner-phone', false, undefined, 'mobile')
  const matesStream = await r.subscribe('mate-phone', false, undefined, 'mobile')
  // The owner's desktop Agents list holds O unread.
  r.runtime.setAgentListPublication({
    publishedAt: 1,
    verdicts: {
      [paneKey!]: {
        listed: true,
        status: 'done',
        unread: true,
        clearable: true,
        sortAt: 1,
        title: 'O'
      }
    }
  })
  const unread = async (deviceId: string, person?: TabListPerson) =>
    (await r.list(deviceId, undefined, person, 'mobile')).tabs.flatMap((tab) =>
      tab.unread === true ? [tab.sessionId] : []
    )

  // Live, to the owner's phone alone.
  await vi.waitFor(() => expect(unreadIn(ownersStream)).toEqual([O]))
  expect(matesStream.flatMap((frame) => unreadIn([frame]))).toEqual([])
  expect(await unread('owner-phone')).toEqual([O])
  // Watched lists go as they are; a teammate never gets the owner's marks.
  expect(await unread('owner-phone', MATE)).toEqual([])
  expect(await unread('owner-phone', 'owner')).toEqual([])
  expect(await unread('mate-phone')).toEqual([])
  expect(await unread('mate-phone', 'owner')).toEqual([])
})

type Rig = Awaited<ReturnType<typeof rig>>

/** A watched read or close of `person`'s list; refused with no list to answer from. */
const watched = (r: Rig, method: string, person: TabListPerson) =>
  r.send('mate-desk', method, {
    worktree: `id:${r.workspace}`,
    tabId: `agent-session:${O}`,
    reason: 'user',
    person
  })
const REFUSED = { ok: false, error: { message: 'unknown_tab_list_person' } }

it('refuses to read or close the list of someone the agent isn’t shared with', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  const owner = await r.ownerView()
  for (const method of ['session.tabs.list', 'session.tabs.close']) {
    expect(await watched(r, method, { accountId: 'usr_stranger' })).toMatchObject(REFUSED)
  }
  await chatTabCommandsSettled()
  expect(await r.ownerView()).toBe(owner)
})

it('refuses the list of someone who declined the share', async () => {
  const r = await rig()
  const bot = r.runtime.bots.list()[0]!
  r.profile.saveBot({
    ...bot,
    shares: bot.shares?.map((share) =>
      share.kind === 'account' && share.accountId === OTHER.accountId
        ? { ...share, declinedAt: 2 }
        : share
    )
  })
  expect(await watched(r, 'session.tabs.list', { accountId: OTHER.accountId })).toMatchObject(
    REFUSED
  )
  expect(await watched(r, 'session.tabs.list', MATE)).toMatchObject({ ok: true })
})

it('refuses a teammate’s list in a worker’s workspace, whose one list is the host’s', async () => {
  const r = await rig({ home: 'other' })
  expect(await watched(r, 'session.tabs.list', MATE)).toMatchObject(REFUSED)
  expect(sessions(await r.list('mate-desk', undefined, 'owner'))).toEqual(
    sessions(await r.list('owner-desk'))
  )
})

// Viewing another person's chats waits for the layout refactor; a teammate's chats now live in their
// own workspace, which no viewer reads, and their pinned Home row is that workspace's tab props.
describe.skip('another person’s chats in a watched list', () => {
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
    // A closed tab's chat keeps running: nothing stops a session.
    const stops = vi.spyOn(r.host, 'close')
    const ownersStream = await r.subscribe('owner-desk')
    const othersStream = await r.subscribe('other-desk')
    const heard = () => [ownersStream.length, othersStream.length]
    const quiet = heard()

    // A close without a reason is refused in the watched list as it is, and no one's list is resent.
    for (const [tabId, person] of [
      [`agent-session:${C}`, { accountId: OTHER.accountId }],
      [(await r.list('owner-desk')).tabs[0]!.id, 'owner' as const]
    ] as const) {
      expect(
        await r.call('mate-desk', 'session.tabs.close', {
          worktree: `id:${r.workspace}`,
          tabId,
          person
        })
      ).toEqual({ closed: true, refused: true, refusalReason: 'missing-intent' })
    }
    await chatTabCommandsSettled()
    expect(heard()).toEqual(quiet)
    expect(sessions(await r.list('other-desk'))).toEqual([C])
    expect(await r.ownerView()).toBe(owner)

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
    expect(stops).not.toHaveBeenCalled()
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

    // The owner's Home is "Home" on the owner's list, and by the owner's name on anyone else's.
    await r.host.deps.store.setUserConversationName(O, BOT_HOME_NAME, 'rename')
    const titleOfO = (tabs: Tabs) =>
      z.object({ title: z.string() }).parse(tabs.tabs.find((tab) => tab.sessionId === O)).title
    expect(titleOfO(await r.list('owner-desk'))).toBe(BOT_HOME_NAME)
    expect(titleOfO(await r.list('mate-desk', undefined, 'owner'))).toBe(BOT_HOME_NAME)
    expect(titleOfO(await r.list('mate-desk'))).toBe(ownerHomeName(null))
    expect(titleOfO(await r.list('owner-desk', undefined, MATE))).toBe(ownerHomeName(null))
  })
})
