// Each person on a shared agent's host has their own tab list in its Home; every other workspace has
// one list, shared. Through the real dispatcher, runtime, chat host and record store.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  B,
  C,
  authorityProfile,
  openAuthorityRuntime,
  physicalReload,
  root,
  savedIds,
  type AuthorityRig
} from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import type { BotShareDevices } from './bot-share-access'
import { botShareAsker } from './bot-share-chats'
import { readBotConversationActsFor } from '../bot-conversation-acts-for'
import { teammateTabListKey } from './teammate-rules'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { makeTestBot } from '../bot.test-fixture'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

const TEAMMATE = { botId: 'bot-1', accountId: 'usr_mate' }
const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  ...TEAMMATE,
  name: 'Mate',
  workspaceTier: true
}
const OTHER = { botId: 'bot-1', accountId: 'usr_other' }
// The owner's own chat in the agent's Home.
const O = 'chat-o-0005'

const Tabs = z.looseObject({
  worktree: z.string(),
  publicationEpoch: z.string(),
  snapshotVersion: z.number(),
  activeTabId: z.string().nullable(),
  tabs: z.array(z.looseObject({ id: z.string(), sessionId: z.string().optional() }))
})
type Tabs = z.infer<typeof Tabs>
const All = z.looseObject({ snapshots: z.array(Tabs) })
const sessions = (tabs: Tabs) => tabs.tabs.flatMap((tab) => tab.sessionId ?? [])

// The open profile: a restart closes the one before it.
let profile: AuthorityRig['profile'] | null = null
afterEach(async () => {
  // Every write lands before the shared teardown removes the profile's folder (#50219's CI flake).
  await chatTabCommandsSettled()
  await profile?.flushPendingOrThrowAsync()
  profile = null
  vi.unstubAllEnvs()
})

const share = (accountId: string, name: string) => ({
  kind: 'account' as const,
  shareId: `share-${accountId}`,
  accountId,
  name,
  email: `${accountId}@example.com`,
  addedAt: 1,
  acceptedAt: 1
})

/** Devices: the owner's `owner-*` computers and phone; Mate's desk and phone; Other's desk. */
function shareDevices(): BotShareDevices {
  return {
    teammateOfDevice: (deviceId) =>
      deviceId.startsWith('mate-') ? TEAMMATE : deviceId.startsWith('other-') ? OTHER : null,
    isOwnerDevice: (deviceId) => deviceId.startsWith('owner-'),
    mintBotShareOffer: vi.fn(),
    revokeBotShareDevices: vi.fn(),
    provisionBotSharePhone: vi.fn(),
    revokeBotSharePhone: vi.fn(),
    getE2EEPublicKey: () => null,
    reachedAccounts: () => new Map(),
    deliverBotShareHeldMessage: vi.fn()
  }
}

/** `home`: which folder is the agent's Home; the rig's own workspace by default, else a second one
 *  (so the rig's workspace is one of the agent's workers' workspaces). */
async function rig(options: { home?: 'rig' | 'other'; opened?: AuthorityRig } = {}) {
  const opened =
    options.opened ??
    (await openAuthorityRuntime(await authorityProfile([], { records: [B, C, O] })))
  const homeFolder =
    options.home === 'other'
      ? opened.profile.createFolderWorkspace({
          projectGroupId: opened.groupId,
          folderPath: root,
          name: 'Agent home'
        }).id
      : opened.folderId
  if (!options.opened) {
    opened.profile.saveBot(
      makeTestBot({
        id: TEAMMATE.botId,
        folderWorkspaceId: homeFolder,
        shares: [share(TEAMMATE.accountId, 'Mate'), share(OTHER.accountId, 'Other')]
      })
    )
    for (const sessionId of [B, C]) {
      opened.runtime
        .getOrchestrationDb()
        .recordBotConversationActsFor(sessionId, { actsFor: [botShareAsker(SCOPE)] })
    }
  }
  profile = opened.profile
  opened.runtime.botShareDevices = shareDevices()
  const dispatcher = new RpcDispatcher({ runtime: opened.runtime, methods: ALL_RPC_METHODS })
  const context = (deviceId: string) => ({
    pairedDeviceId: deviceId,
    connectionId: `socket-${deviceId}`,
    clientKind: 'runtime' as const,
    // As a desktop's handshake sends them.
    clientCapabilities: remoteRuntimeClientCapabilities(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    ),
    callerScope: deviceId.startsWith('mate-')
      ? SCOPE
      : deviceId.startsWith('other-')
        ? { ...SCOPE, ...OTHER, name: 'Other' }
        : { kind: 'runtime-paired' as const, grants: [] }
  })
  const send = (deviceId: string, method: string, params: unknown) =>
    dispatcher.dispatch(
      { id: `${method}-${randomUUID()}`, authToken: '', method, params },
      context(deviceId)
    )
  const call = async (deviceId: string, method: string, params: unknown) => {
    const reply = await send(deviceId, method, params)
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
    return reply.ok ? reply.result : undefined
  }
  const worktree = `id:${opened.workspace}`
  const home = folderWorkspaceKey(homeFolder)
  const list = async (deviceId: string, where = worktree) =>
    Tabs.parse(await call(deviceId, 'session.tabs.list', { worktree: where }))
  /** A device's live frames: one workspace's stream, or with `all` its census stream. */
  const subscribe = async (deviceId: string, all = false) => {
    const frames: Tabs[] = []
    void dispatcher.dispatchStreamingObjects(
      {
        id: `sub-${deviceId}-${all}`,
        authToken: '',
        method: all ? 'session.tabs.subscribeAll' : 'session.tabs.subscribe',
        params: all ? null : { worktree }
      },
      (response) => {
        const frame = response.ok
          ? z.looseObject({ type: z.string() }).parse(response.result)
          : null
        if (frame?.type === 'snapshot' || frame?.type === 'updated') {
          frames.push(Tabs.parse(frame))
        }
        if (frame?.type === 'snapshots') {
          frames.push(...All.parse(frame).snapshots)
        }
      },
      context(deviceId)
    )
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    return frames
  }
  const create = async (deviceId: string, where = worktree) => {
    // The agent's runtime home is made under the app's data folder: the test's own.
    vi.stubEnv('ORCA_USER_DATA_PATH', root)
    const sessionId = randomUUID()
    await call(deviceId, 'agentSession.create', {
      envelope: {
        sessionId,
        clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
        expectedRuntimeFence: null,
        // As the client signs it.
        payloadFingerprint: structuredAgentSessionCreateFingerprint({
          sessionId,
          worktree: where,
          agent: 'codex'
        })
      },
      worktree: where,
      agent: 'codex'
    })
    return sessionId
  }
  return {
    ...opened,
    home,
    send,
    call,
    list,
    subscribe,
    create,
    /** The host's list in the rig's workspace, as the owner's window holds it. */
    hostChats: async () =>
      (await opened.runtime.listMobileSessionTabs(opened.workspace)).tabs.flatMap((tab) =>
        tab.type === 'agent-session' ? [tab.sessionId] : []
      ),
    /** Everything the owner sees of the rig's workspace, byte for byte. */
    ownerView: async () =>
      JSON.stringify({
        desk: await list('owner-desk'),
        phone: await list('owner-phone'),
        host: await opened.runtime.listMobileSessionTabs(opened.workspace),
        saved: savedIds(opened),
        visible: [B, C, O].filter((id) => opened.host.isSessionTabVisible(id))
      }),
    reveal: (deviceId: string, sessionId: string) =>
      call(deviceId, 'agentSession.reveal', { sessionId, navigation: 'caller' }),
    activate: (deviceId: string, sessionId: string) =>
      call(deviceId, 'session.tabs.activate', {
        worktree,
        tabId: `agent-session:${sessionId}`,
        navigation: 'caller'
      }),
    close: (deviceId: string, sessionId: string) =>
      call(deviceId, 'session.tabs.close', {
        worktree,
        tabId: `agent-session:${sessionId}`,
        reason: 'user'
      })
  }
}

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
  const refused = await r.send('mate-desk', 'session.tabs.createTerminal', {
    worktree: `id:${r.workspace}`
  })
  expect(refused).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(await r.hostChats()).toEqual([])
})

it('moves a teammate’s tab an older build saved in the owner’s list to their own, once', async () => {
  const r = await rig()
  // What an older build did for a teammate: the paired-caller reveal into the host's list.
  await r.reveal('owner-phone', C)
  await r.reveal('owner-desk', O)
  expect(await r.hostChats()).toEqual([C, O])

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
})

it('lists a teammate’s chats in the owner’s chat list under their name; the owner opening one changes only the owner’s list', async () => {
  const r = await rig()
  // Their New chat acts for them, so it lists under their name once it holds a turn; an empty chat
  // lists for no one (the seeded C stands in for one that has talked).
  const started = z
    .object({ sessionId: z.string() })
    .parse(await r.call('mate-desk', 'bots.session.start', { botId: TEAMMATE.botId }))
  expect(readBotConversationActsFor(r.runtime, started.sessionId)?.actsFor).toEqual([
    botShareAsker(SCOPE)
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
