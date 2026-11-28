// Each person on a shared agent's host has their own tab list in its Home; every other workspace has
// one list, shared. Through the real dispatcher, runtime, chat host and record store.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  physicalReload,
  savedIds
} from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { showBotSessionTab } from '../bot-session-tab-show'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { botShareAsker } from './bot-share-chats'
import { readBotConversationActsFor } from '../bot-conversation-acts-for'
import { teammateTabListKey } from './teammate-rules'
import { setRuntimeDesktopSurface } from '../../runtime/construction/runtime-desktop-surface'
import {
  All,
  B,
  C,
  O,
  rig,
  SCOPE,
  sessions,
  settleTeammateRig,
  SHARED,
  stubUserData,
  Tabs,
  TEAMMATE
} from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

it('leaves the owner’s Home list byte-identical through a teammate’s reveal, create, activate, close and a restore', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  const before = await r.ownerView()

  await r.reveal('mate-desk', C)
  const created = await r.create('mate-desk')
  await r.reveal('mate-desk', B)
  await r.activate('mate-desk', C)
  await r.close('mate-desk', B)
  await chatTabCommandsSettled()

  expect(await r.ownerView()).toBe(before)
  expect(sessions(await r.list('mate-phone'))).toEqual([C, created])
  expect(r.host.isSessionTabVisible(created)).toBe(false)

  // A restart: the owner's list comes back as it was, and so does Mate's own.
  const fresh = await rig({ opened: await physicalReload(r) })
  expect(await fresh.hostChats()).toEqual([O])
  expect(savedIds(fresh)).toEqual([O])
  expect(sessions(await fresh.list('owner-desk'))).toEqual([O])
  expect(sessions(await fresh.list('mate-desk'))).toEqual([C, created])
})

it('never touches a teammate’s list when the owner’s window drops an empty Home', async () => {
  const r = await rig()
  await r.reveal('mate-desk', C)
  const phone = await r.subscribe('mate-phone')
  const seen = phone.length
  await r.reveal('owner-desk', O)
  const ownersTab = (await r.list('owner-desk')).tabs.find((tab) => tab.sessionId === O)!
  await r.call('owner-desk', 'session.tabs.close', {
    worktree: `id:${r.workspace}`,
    tabId: ownersTab.id,
    reason: 'user'
  })
  expect(await r.hostChats()).toEqual([])
  // What the window's reconciliation does when it no longer lists the Home (#50219 round 2, 1).
  r.runtime['notifyMobileSessionTabsRemoved'](r.workspace)
  await chatTabCommandsSettled()

  expect(sessions(await r.list('mate-desk'))).toEqual([C])
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  expect(phone.slice(seen).filter((frame) => sessions(frame).length === 0)).toEqual([])
  const saved = r.profile.getMobileClientTabSelections()[teammateTabListKey(TEAMMATE)]
  expect(saved?.[r.workspace]?.personTabs).toEqual([C])
})

it('shows a teammate’s two devices one list, each with its own focus', async () => {
  const r = await rig()
  await r.reveal('mate-desk', B)
  await r.reveal('mate-phone', C)
  await r.activate('mate-desk', C)
  await r.activate('mate-phone', B)

  const desk = await r.list('mate-desk')
  const phone = await r.list('mate-phone')
  expect(sessions(desk)).toEqual([B, C])
  expect(sessions(phone)).toEqual([B, C])
  expect(desk.activeTabId).toBe(`agent-session:${C}`)
  expect(phone.activeTabId).toBe(`agent-session:${B}`)
  // Another teammate of the same agent has their own list, empty.
  expect(sessions(await r.list('other-desk'))).toEqual([])
})

it('puts a teammate’s tab in a worker workspace in the one shared list the owner sees', async () => {
  const r = await rig({ home: 'other' })
  await r.reveal('mate-desk', C)

  expect(await r.hostChats()).toEqual([C])
  expect(sessions(await r.list('owner-desk'))).toEqual([C])
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  // The Home is still Mate's own, empty.
  expect(sessions(await r.list('mate-desk', `id:${r.home}`))).toEqual([])
})

it('lists a teammate’s Home in listAll and subscribeAll with no host tab there (#50219 round 1, 1)', async () => {
  const r = await rig()
  // A windowless host (orca serve) answers the all-workspace census from main's own graph.
  r.runtime['restoreHeadlessGraphAuthority']()
  await r.reveal('mate-desk', C)

  const listed = All.parse(await r.call('mate-phone', 'session.tabs.listAll', null))
  expect(listed.snapshots.filter((s) => s.worktree === r.workspace).map(sessions)).toEqual([[C]])
  const census = await r.subscribe('mate-phone', true)
  expect(census.filter((s) => s.worktree === r.workspace).map(sessions)).toEqual([[C]])
})

it('updates a teammate’s other device live, past its first empty frame (#50219 round 1, 2)', async () => {
  const r = await rig()
  const phone = await r.subscribe('mate-phone')
  const first = phone[0]!
  expect(sessions(first)).toEqual([])

  await r.reveal('mate-desk', C)
  await vi.waitFor(() => expect(phone.some((frame) => sessions(frame).includes(C))).toBe(true))
  const shown = phone.find((frame) => sessions(frame).includes(C))!
  // A desktop drops a frame that does not outrank the one it holds.
  expect(shown.publicationEpoch).toBe(first.publicationEpoch)
  expect(shown.snapshotVersion).toBeGreaterThan(first.snapshotVersion)
})

it('answers a teammate’s activate with their own list, never the owner’s (#50219 round 1, 3)', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  const owner = await r.subscribe('owner-desk')
  const seen = owner.length

  // No navigation named: a teammate's own list is activated on their device alone (round 2, 3).
  const reply = Tabs.parse(
    await r.call('mate-desk', 'session.tabs.activate', {
      worktree: `id:${r.workspace}`,
      tabId: `agent-session:${C}`
    })
  )
  expect(sessions(reply)).toEqual([C])
  expect(reply.activeTabId).toBe(`agent-session:${C}`)
  await chatTabCommandsSettled()
  expect(owner.slice(seen)).toEqual([])
  // An owner's tab is not in a teammate's list to activate or close.
  for (const method of ['session.tabs.activate', 'session.tabs.close']) {
    const refused = await r.send('mate-desk', method, {
      worktree: `id:${r.workspace}`,
      tabId: `agent-session:${O}`,
      reason: 'user'
    })
    expect(refused.ok).toBe(false)
  }
  expect(await r.hostChats()).toEqual([O])
})

it('never returns to a closed tab when it opens again, after a restart too (#50219 round 1, 4; round 2, 2)', async () => {
  const r = await rig()
  await r.reveal('mate-desk', B)
  await r.reveal('mate-desk', C)
  await r.activate('mate-desk', C)
  await r.activate('mate-phone', C)
  // The phone is away (not listening) while the desk closes its pick.
  await r.close('mate-desk', C)
  expect((await r.list('mate-desk')).activeTabId).toBe(`agent-session:${B}`)

  const fresh = await rig({ opened: await physicalReload(r) })
  await fresh.reveal('mate-desk', C)
  expect(sessions(await fresh.list('mate-phone'))).toEqual([B, C])
  expect((await fresh.list('mate-phone')).activeTabId).toBe(`agent-session:${B}`)
  expect((await fresh.list('mate-desk')).activeTabId).toBe(`agent-session:${B}`)
})

it('refuses a host-list tab write in a teammate’s own Home', async () => {
  const r = await rig()
  const refused = await r.send('mate-desk', 'terminal.create', { worktree: `id:${r.workspace}` })
  expect(refused).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(await r.hostChats()).toEqual([])
})

it('moves a teammate’s tab an older build saved in the owner’s list to their own, once', async () => {
  const r = await rig()
  // What an older build did for a teammate: the paired-caller reveal into the host's list.
  await r.reveal('owner-phone', C)
  await r.reveal('owner-desk', O)
  expect(await r.hostChats()).toEqual([C, O])

  // The upgrade's first start, which has not moved this Home's tabs yet.
  r.runtime['personSessionTabs']['movedHomes'].clear()
  await r.runtime['backfillBotBackgroundChats']()
  await chatTabCommandsSettled()
  expect(await r.hostChats()).toEqual([O])
  expect(savedIds(r)).toEqual([O])
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  // Again: nothing left to move, nothing changes.
  const after = await r.ownerView()
  await r.runtime['backfillBotBackgroundChats']()
  expect(await r.ownerView()).toBe(after)

  const fresh = await rig({ opened: await physicalReload(r) })
  expect(sessions(await fresh.list('mate-desk'))).toEqual([C])
  expect(await fresh.hostChats()).toEqual([O])
  // Moved once: a teammate's chat the owner opens later stays in the owner's list, restarts too.
  await fresh.reveal('owner-phone', B)
  await fresh.runtime['backfillBotBackgroundChats']()
  expect(await fresh.hostChats()).toEqual([O, B])
  // Two more restarts: the saved marker survives loading, so the move never runs again.
  let again = fresh
  for (let restart = 0; restart < 2; restart += 1) {
    again = await rig({ opened: await physicalReload(again) })
    await again.runtime['backfillBotBackgroundChats']()
    await chatTabCommandsSettled()
    expect(await again.hostChats()).toEqual([O, B])
    expect(sessions(await again.list('mate-desk'))).toEqual([C])
  }
})

it('lists a teammate’s chats in the owner’s chat list under their name; the owner opening one changes only the owner’s list', async () => {
  const r = await rig()
  // Their New chat acts for them, so it lists under their name once it holds a turn; an empty chat
  // lists for no one (the seeded C stands in for one that has talked).
  // The new chat's agent home is made under the app's data folder: the test's own.
  stubUserData()
  const started = z
    .object({ sessionId: z.string() })
    .parse(await r.call('mate-desk', 'bots.session.start', { botId: TEAMMATE.botId }))
  expect(readBotConversationActsFor(r.runtime, started.sessionId)?.actsFor).toEqual([
    botShareAsker(SHARED, SCOPE)
  ])
  const Tree = z.object({
    chats: z.array(z.looseObject({ chatId: z.string(), person: z.unknown().optional() }))
  })
  const tree = Tree.parse(await r.call('owner-desk', 'bots.chatTree', { botId: TEAMMATE.botId }))
  expect(tree.chats.find((chat) => chat.chatId === C)?.person).toEqual({
    accountId: TEAMMATE.accountId,
    name: 'Mate'
  })
  await r.reveal('mate-desk', C)
  // Their tab lists; who sends as which pane is the workspace's, and the owner's open adds C's.
  const mates = async () =>
    JSON.stringify(
      [await r.list('mate-desk'), await r.list('mate-phone')].map(
        ({ agentSenderAssociations: _senders, ...tabs }) => tabs
      )
    )
  const before = await mates()

  await r.reveal('owner-desk', C)
  expect(await r.hostChats()).toEqual([C])
  expect(sessions(await r.list('owner-phone'))).toEqual([C])
  expect(await mates()).toBe(before)
})

it('shows a chat a teammate closed as their last tab again on their offline device when it reopens', async () => {
  const r = await rig()
  await r.reveal('mate-desk', C)
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  // The phone is away while the desk closes the Home's only tab, then opens the chat again.
  await r.close('mate-desk', C)
  await r.reveal('mate-desk', C)

  expect(sessions(await r.list('mate-phone'))).toEqual([C])
})

it('moves a teammate’s list to a new version when a chat in it is renamed', async () => {
  const r = await rig()
  await r.reveal('mate-desk', C)
  const before = await r.list('mate-phone')

  // Where a rename (or a title the agent picks) lands: the chat's tabs retitle.
  r.runtime.refreshStructuredConversationTabTitle(r.workspace, C)

  // A desktop drops a frame that does not outrank the one it holds.
  const after = await r.list('mate-phone')
  expect(after.publicationEpoch).toBe(before.publicationEpoch)
  expect(after.snapshotVersion).toBeGreaterThan(before.snapshotVersion)
})

it('activates a bot link only on the chat it names, in a teammate’s own list', async () => {
  const r = await rig()
  await r.reveal('mate-desk', B)
  await r.reveal('mate-desk', C)
  const link = (sessionId: string) => ({
    botId: TEAMMATE.botId,
    conversation: { source: 'slack', externalId: 'thread-1' },
    leadSessionId: sessionId,
    sessionId,
    worktreeId: r.workspace
  })
  const activate = (botLinkTarget: unknown) =>
    r.send('mate-desk', 'session.tabs.activate', {
      worktree: `id:${r.workspace}`,
      tabId: `agent-session:${C}`,
      navigation: 'caller',
      botLinkTarget
    })
  const before = (await r.list('mate-desk')).activeTabId

  // The link names B, the tab is C: the check reads the tab's own chat, so it refuses.
  expect(await activate(link(B))).toMatchObject({
    ok: false,
    error: { message: 'bot_link_target_changed' }
  })
  expect((await r.list('mate-desk')).activeTabId).toBe(before)
  expect(await r.hostChats()).toEqual([])
})

it('closes only a teammate’s own tab when they close a chat in their Home', async () => {
  const r = await rig()
  await r.reveal('owner-desk', C)
  await r.reveal('mate-desk', C)
  const before = await r.ownerView()

  await r.call('mate-desk', 'agentSession.close', { sessionId: C })
  await chatTabCommandsSettled()

  expect(sessions(await r.list('mate-phone'))).toEqual([])
  expect(await r.hostChats()).toEqual([C])
  expect(await r.ownerView()).toBe(before)
})

it('answers a teammate’s close with no reason from their own list, never republishing the owner’s', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  const owner = await r.subscribe('owner-desk')
  const seen = owner.length

  const reply = await r.call('mate-desk', 'session.tabs.close', {
    worktree: `id:${r.workspace}`,
    tabId: `agent-session:${C}`
  })
  await chatTabCommandsSettled()

  expect(reply).toMatchObject({ refused: true, refusalReason: 'missing-intent' })
  expect(owner.slice(seen)).toEqual([])
  expect(sessions(await r.list('mate-desk'))).toEqual([C])
})

it('refuses a teammate’s agent launch into their own Home before it writes a tab', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  const before = await r.ownerView()
  for (const method of ['agent.launch', 'agent.launchReplay']) {
    const refused = await r.send('mate-desk', method, {
      agent: 'codex',
      target: { kind: 'existing', worktree: `id:${r.workspace}` },
      surface: 'terminal',
      operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`
    })
    expect(refused, method).toMatchObject({ ok: false, error: { code: 'not_found' } })
  }
  expect(await r.ownerView()).toBe(before)
})

it('never opens a tab in the host’s window for a teammate’s terminal with no workspace', async () => {
  const r = await rig()
  const requested: string[] = []
  setRuntimeDesktopSurface({
    showNotification: () => false,
    hasWindow: () => true,
    hasLiveRenderer: () => true,
    sendToWindow: () => true,
    requestRenderer: (_windowId, request) => {
      requested.push(request.channel)
      return Promise.reject(new Error('the window is not part of this test'))
    }
  })
  try {
    r.runtime.attachWindow(1)
    r.runtime['graphStatus'] = 'ready'
    expect(await r.send('mate-desk', 'terminal.create', {})).toMatchObject({ ok: false })
    expect(requested).toEqual([])
    // The owner's devices still reach it, so the refusal is the teammate's alone.
    await r.send('owner-desk', 'terminal.create', {})
    expect(requested).toEqual(['terminal:requestTabCreate'])
  } finally {
    setRuntimeDesktopSurface(null)
  }
})

it('shows a teammate’s chat the agent publishes during its turn in their list, never the owner’s', async () => {
  const r = await rig()
  const bot = r.runtime.bots.list()[0]!
  // The agent's own publish (a turn's, a request's): no one called, so the chat's stamp decides.
  await showBotSessionTab(r.runtime, bot, C)
  await chatTabCommandsSettled()

  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  expect(await r.hostChats()).toEqual([])
  // The owner's own chat goes to the owner's list.
  await showBotSessionTab(r.runtime, bot, O)
  expect(await r.hostChats()).toEqual([O])
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
})

it('publishes an owner’s turn after a teammate’s call to the owner’s list alone', async () => {
  const r = await rig()
  const bot = r.runtime.bots.list()[0]!
  // Work a teammate's call starts that runs later (a provider child, a host timer): the owner's
  // chat's turn publishes from it.
  let later: Promise<void> | undefined
  const ensure = r.runtime.ensureStructuredAgentSessionHost.bind(r.runtime)
  vi.spyOn(r.runtime, 'ensureStructuredAgentSessionHost').mockImplementationOnce(async () => {
    later = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
      showBotSessionTab(r.runtime, bot, O)
    )
    return ensure()
  })
  stubUserData()
  await r.call('mate-desk', 'bots.session.start', { botId: TEAMMATE.botId })
  await later
  await chatTabCommandsSettled()

  expect(await r.hostChats()).toEqual([O])
  expect(sessions(await r.list('mate-desk'))).not.toContain(O)
})

it('restores the owner’s Home on a cold start a teammate’s first call begins, beside their own list', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)

  const fresh = await rig({ opened: await physicalReload(r, { restore: false }) })
  // The teammate's list is the first call after the restart: it starts the host's restore.
  expect(sessions(await fresh.list('mate-desk'))).toEqual([C])
  expect(await fresh.hostChats()).toEqual([O])
  expect(sessions(await fresh.list('owner-desk'))).toEqual([O])
})

it('leaves the owner’s list as it was when a teammate starts a new Home Chat', async () => {
  const r = await rig()
  const Opened = z.object({ sessionId: z.string() })
  stubUserData()
  const home = Opened.parse(
    await r.call('mate-desk', 'bots.chat.open', { botId: TEAMMATE.botId })
  ).sessionId
  // The owner opens the teammate's Home Chat in the owner's own list.
  await r.reveal('owner-desk', home)
  await r.reveal('mate-desk', home)
  const before = await r.list('owner-desk')

  const reset = Opened.parse(
    await r.call('mate-desk', 'bots.chat.reset', { botId: TEAMMATE.botId })
  ).sessionId
  await chatTabCommandsSettled()

  expect(reset).not.toBe(home)
  expect(sessions(await r.list('owner-desk'))).toEqual(sessions(before))
  expect(await r.hostChats()).toEqual([home])
  expect(sessions(await r.list('mate-desk'))).not.toContain(home)
})

it('renames a teammate’s terminal in a worker workspace through the host window, as for anyone', async () => {
  const r = await rig({ home: 'other' })
  const renamed: string[] = []
  r.runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: (tabId) => void renamed.push(tabId),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  // A live terminal the window has not published a tab row for yet.
  const tabId = '33333333-3333-4333-8333-333333333333'
  r.runtime.registerPty('pty-worker', r.workspace, null, {
    tabId,
    leafId: '44444444-4444-4444-8444-444444444444',
    terminalHandle: 'term_worker'
  })
  try {
    await r.call('mate-desk', 'terminal.rename', { terminal: 'term_worker', title: 'Build' })
    expect(renamed).toEqual([tabId])
  } finally {
    await r.runtime.onPtyExit('pty-worker', 0)
    r.runtime.setNotifier(null)
  }
})

it('closes a deleted chat’s tab in every person’s list, on every device', async () => {
  const r = await rig()
  // The teammate's chat, open in their list and in the owner's.
  await r.reveal('mate-desk', C)
  await r.reveal('owner-desk', C)
  await r.reveal('owner-desk', O)
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  expect(await r.hostChats()).toEqual([C, O])

  expect(await r.call('owner-desk', 'agentSession.delete', { sessionId: C })).toMatchObject({
    outcome: 'deleted'
  })
  await chatTabCommandsSettled()

  for (const device of ['mate-desk', 'mate-phone', 'owner-desk', 'owner-phone']) {
    expect(sessions(await r.list(device)), device).not.toContain(C)
  }
  expect(await r.hostChats()).toEqual([O])
  const saved = r.profile.getMobileClientTabSelections()[teammateTabListKey(TEAMMATE)]
  expect(saved?.[r.workspace]?.personTabs ?? []).toEqual([])
})
