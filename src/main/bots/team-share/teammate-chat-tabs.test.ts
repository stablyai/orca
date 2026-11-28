// A teammate's chat tabs live in their own workspace in a shared agent's Home: each open, close and
// rename there leaves the owner's window, chat tabs and the chat's host tab row as they were, and a
// running chat keeps running. Through the real dispatcher, runtime, chat host and record store.
import { afterEach, expect, it, vi } from 'vitest'
import { physicalReload } from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { showBotSessionTab } from '../bot-session-tab-show'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import { B, C, O, rig, settleTeammateRig } from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

type Rig = Awaited<ReturnType<typeof rig>>

/** One teammate act, watched: the owner gets nothing and sees nothing new, and no chat stops. */
async function ownerUntouchedBy(r: Rig, act: () => Promise<unknown>): Promise<void> {
  const view = await r.ownerView()
  const probe = ownerWindowProbe(r.runtime, r.profile, r.workspace)
  const stops = vi.spyOn(r.host, 'close')
  try {
    const owner = await probe.ownerState()
    await act()
    await chatTabCommandsSettled()
    // The held-mail set is host-wide; a newly attached window (the probe's) is sent it whole.
    expect(probe.relays.filter((relay) => relay.name !== 'sleepingMailChanged')).toEqual([])
    expect(await probe.ownerState()).toBe(owner)
    expect(stops).not.toHaveBeenCalled()
  } finally {
    probe.close()
    stops.mockRestore()
  }
  expect(await r.ownerView()).toBe(view)
}

const closes = {
  'session.tabs.close': (r: Rig, sessionId: string) => r.closeMine(sessionId),
  'agentSession.close': (r: Rig, sessionId: string) =>
    r.call('mate-desk', 'agentSession.close', { sessionId })
}

for (const [method, close] of Object.entries(closes)) {
  it(`${method}: closes a shared chat the owner also has open in the teammate’s list alone`, async () => {
    const r = await rig()
    await r.reveal('owner-desk', C)
    await r.reveal('mate-desk', C)
    await r.reveal('mate-desk', B)
    expect(r.mine().chats).toEqual([C, B])

    await ownerUntouchedBy(r, () => close(r, C))

    expect(r.mine().chats).toEqual([B])
    expect(r.mineSaved()).toEqual([B])
    expect(await r.hostChats()).toEqual([C])
    expect(r.host.isSessionTabVisible(C)).toBe(true)
  })
}

it('keeps the owner’s own close of the shared chat as it is: the chat runs on', async () => {
  const r = await rig()
  await r.reveal('owner-desk', C)
  await r.reveal('mate-desk', C)
  const stops = vi.spyOn(r.host, 'close')

  await r.call('owner-desk', 'agentSession.close', { sessionId: C })
  await chatTabCommandsSettled()

  expect(stops).not.toHaveBeenCalled()
  expect(await r.hostChats()).toEqual([])
  expect(r.mine().chats).toEqual([C])
})

it('refuses a lifecycle close of a teammate’s chat, which names no terminal, as for the owner', async () => {
  const r = await rig()
  await r.reveal('mate-desk', C)

  let reply: unknown
  await ownerUntouchedBy(r, async () => {
    reply = await r.closeMine(C, { expectedTerminalHandle: 'term_any' })
  })

  expect(reply).toMatchObject({ refused: true, refusalReason: 'stale-terminal' })
  expect(r.mine().chats).toEqual([C])
})

it('opens the owner’s chat in a teammate’s list without moving the owner’s tab or its host row', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)

  await ownerUntouchedBy(r, () => r.reveal('mate-desk', O))
  await ownerUntouchedBy(r, () => showBotSessionTab(r.runtime, r.runtime.bots.list()[0]!, C))

  expect(r.mine().chats).toEqual([O, C])
  expect(r.host.isSessionTabVisible(O)).toBe(true)
  expect(r.host.isSessionTabVisible(C)).toBe(false)
})

it('retitles a teammate’s rows on a rename, leaving the owner’s list as it was', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  const list = () => r.runtime['mobileSessionTabsByWorktree'].get(r.listOf())!
  r.runtime['storeMobileSessionSnapshot'](r.listOf(), {
    ...list(),
    tabs: list().tabs.map((tab) => ({ ...tab, title: 'Before the rename' }))
  })

  await ownerUntouchedBy(r, async () =>
    r.runtime.refreshStructuredConversationTabTitle(r.workspace, C)
  )

  expect(list().tabs[0]?.title).not.toBe('Before the rename')
})

it('restores a teammate’s chats into their own list after a restart, never into the owner’s', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  await r.reveal('mate-desk', B)

  const fresh = await rig({ opened: await physicalReload(r) })

  expect(fresh.mine().chats).toEqual([C, B])
  expect(await fresh.hostChats()).toEqual([O])
  expect([B, C].filter((id) => fresh.host.isSessionTabVisible(id))).toEqual([])
})
