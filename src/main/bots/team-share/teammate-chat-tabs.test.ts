// A teammate's chat tabs live in their own workspace in a shared agent's Home: each open, close and
// rename there leaves the owner's window, chat tabs and the chat's host tab row as they were, and a
// running chat keeps running. Through the real dispatcher, runtime, chat host and record store.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { physicalReload } from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { showBotSessionTab } from '../bot-session-tab-show'
import { ownerWindowProbe } from './owner-window-probe.test-support'
import {
  B,
  C,
  O,
  rig,
  settleTeammateRig,
  stubUserData,
  TEAMMATE
} from './teammate-tabs.test-support'

afterEach(settleTeammateRig)

type Rig = Awaited<ReturnType<typeof rig>>

const HOST_WIDE = new Set(['sleepingMailChanged', 'botsChanged'])

/** One teammate act, watched: the owner gets nothing and sees nothing new, and no chat stops. */
async function ownerUntouchedBy(
  r: Rig,
  act: () => Promise<unknown>,
  /** The act ends a chat by design (a delete, a Home Chat replaced). */
  { ends = false }: { ends?: boolean } = {}
): Promise<void> {
  const view = await r.ownerView()
  const probe = ownerWindowProbe(r.runtime, r.profile, r.workspace)
  const stops = vi.spyOn(r.host, 'close')
  try {
    const owner = await probe.ownerState()
    await act()
    await chatTabCommandsSettled()
    // The held-mail set is host-wide, so a newly attached window (the probe's) is sent it whole,
    // and the agents list is too (a share's Home Chat pointer).
    expect(probe.relays.filter((relay) => !HOST_WIDE.has(relay.name))).toEqual([])
    expect(await probe.ownerState()).toBe(owner)
    if (!ends) {
      expect(stops).not.toHaveBeenCalled()
    }
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
  const titles = () =>
    r.runtime['toMobileSessionTabsResult'](
      r.runtime['mobileSessionTabsByWorktree'].get(r.listOf())!
    ).tabs.map((tab) => tab.title)

  await ownerUntouchedBy(r, async () => {
    await r.host.deps.store.setUserConversationName(C, 'Sprint Plan', 'rename')
    r.runtime.refreshStructuredConversationTabTitle(r.workspace, C)
  })

  expect(titles()).toEqual(['Sprint Plan'])
  // A save of their workspace re-reads its saved titles; the name holds.
  await r.reveal('mate-desk', B)
  await chatTabCommandsSettled()
  expect(titles()[0]).toBe('Sprint Plan')
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

const Opened = z.object({ sessionId: z.string() })

it('opens a teammate’s Home Chat in their own list, its host tab row left unset', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  stubUserData()
  let home = ''

  await ownerUntouchedBy(r, async () => {
    home = Opened.parse(
      await r.call('mate-desk', 'bots.chat.open', { botId: TEAMMATE.botId })
    ).sessionId
    await r.reveal('mate-desk', home)
  })

  expect(r.mine().chats).toEqual([home])
  expect(r.host.isSessionTabVisible(home)).toBe(false)
})

it('replaces a teammate’s Home Chat in their own list alone, the owner’s open tab of it kept', async () => {
  const r = await rig()
  stubUserData()
  const home = Opened.parse(
    await r.call('mate-desk', 'bots.chat.open', { botId: TEAMMATE.botId })
  ).sessionId
  await r.reveal('mate-desk', home)
  // The owner opened the teammate's Home Chat in his own tabs.
  await r.reveal('owner-desk', home)
  let reset = ''

  await ownerUntouchedBy(
    r,
    async () => {
      reset = Opened.parse(
        await r.call('mate-desk', 'bots.chat.reset', { botId: TEAMMATE.botId })
      ).sessionId
    },
    { ends: true }
  )

  expect(reset).not.toBe(home)
  expect(r.host.isSessionTabVisible(home)).toBe(true)
  expect(await r.hostChats()).toEqual([home])
  expect(r.mine().chats).not.toContain(home)
})

it('closes a deleted chat in a teammate’s list, the owner’s list left as it was', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  await r.reveal('mate-desk', B)

  await ownerUntouchedBy(
    r,
    async () => {
      expect(await r.call('mate-desk', 'agentSession.delete', { sessionId: C })).toMatchObject({
        outcome: 'deleted'
      })
    },
    { ends: true }
  )

  expect(r.mine().chats).toEqual([B])
  expect(r.mineSaved()).toEqual([B])
})

it('restores a teammate’s chats with nothing sent to the owner and his saved layout unchanged', async () => {
  const r = await rig()
  await r.reveal('mate-desk', C)
  await r.reveal('mate-desk', B)
  const fresh = await rig({ opened: await physicalReload(r, { restore: false }) })

  await ownerUntouchedBy(fresh, () => fresh.runtime.restoreStructuredAgentSessionTabs())

  expect(fresh.mine().chats).toEqual([C, B])
  expect(await fresh.hostChats()).toEqual([])
})

// A fork's tab is the at-rest create's (`publishTab`), placed where the client asked. The rig's
// agent keeps no transcript to cut, so this drives that create without a fork source.
it('opens a teammate’s placed create (a fork’s tab path) in their own list, its host tab row unset', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  await r.reveal('mate-desk', B)
  stubUserData()
  const sessionId = randomUUID()
  const where = `id:${r.workspace}`

  await ownerUntouchedBy(r, () =>
    r.call('mate-desk', 'agentSession.create', {
      envelope: {
        sessionId,
        clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
        expectedRuntimeFence: null,
        payloadFingerprint: structuredAgentSessionCreateFingerprint({
          sessionId,
          worktree: where,
          agent: 'codex'
        })
      },
      worktree: where,
      agent: 'codex',
      tabPlacement: { afterTabId: `agent-session:${C}` }
    })
  )

  // Placed after C, live and saved.
  expect(r.mine().chats).toEqual([C, sessionId, B])
  expect(r.mineSaved()).toEqual([C, sessionId, B])
  expect(r.host.isSessionTabVisible(sessionId)).toBe(false)
})

it('titles a teammate’s fork by its source and retitles it when the source is renamed', async () => {
  const F = 'chat-f-fork'
  // An older build's fork of C, saved under "<source> fork"; it reads as its source's name.
  const r = await rig({
    chats: {
      [C]: { conversationName: 'Release' },
      [F]: {
        conversationName: 'Release fork',
        forkedFrom: { sessionId: C, itemId: 'item-1', childBoundary: { kind: 'start' } }
      }
    }
  })
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  await r.reveal('mate-desk', F)
  const rows = () =>
    r.runtime['toMobileSessionTabsResult'](
      r.runtime['mobileSessionTabsByWorktree'].get(r.listOf())!
    ).tabs.map((tab) => ({ title: tab.title, forked: 'forked' in tab ? tab.forked : undefined }))
  expect(rows()).toEqual([
    { title: 'Release', forked: undefined },
    { title: 'Release', forked: true }
  ])

  await ownerUntouchedBy(r, async () => {
    await r.host.deps.store.setUserConversationName(C, 'Sprint Plan', 'rename')
    r.runtime.refreshStructuredConversationTabTitle(r.workspace, C)
  })

  // The source moved off the name the fork was saved under, so the fork keeps its own: the rows
  // the list holds and sends are retitled, not only those read afresh.
  const stored = r.runtime['mobileSessionTabsByWorktree']
    .get(r.listOf())!
    .tabs.map((tab) => ({ title: tab.title, forked: 'forked' in tab ? tab.forked : undefined }))
  expect(stored).toEqual(rows())
  expect(rows()).toEqual([
    { title: 'Sprint Plan', forked: undefined },
    { title: 'Release fork', forked: true }
  ])
})
