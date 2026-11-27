// A teammate's chats in a shared agent's home are in their own tabs, on every device of theirs, and
// never in the host's tab list; the owner's own paired screens still share the host's list.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  B,
  C,
  authorityProfile,
  openAuthorityRuntime,
  root,
  savedIds
} from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import type { BotShareDevices } from './bot-share-access'
import { botShareAsker } from './bot-share-chats'
import { moveTeammateHostTabs } from './teammate-host-tab-move'
import { teammateTabSetKey } from '../../runtime/client/navigation/client-session-person-tabs'
import { ClientSessionTabSelectionStore } from '../../runtime/client/navigation/client-session-tab-selection'
import { closeTestStores, createStore } from '../../persistence/persistence-test-harness'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { makeTestBot } from '../bot.test-fixture'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'

const TEAMMATE = { botId: 'bot-1', accountId: 'usr_mate' }
const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  ...TEAMMATE,
  name: 'Mate',
  workspaceTier: true
}
// The owner's own chat in the agent's home.
const O = 'chat-o-0005'

const Tabs = z.looseObject({
  worktree: z.string(),
  publicationEpoch: z.string(),
  snapshotVersion: z.number(),
  activeTabId: z.string().nullable(),
  tabs: z.array(z.looseObject({ id: z.string(), sessionId: z.string().optional() }))
})
const sessions = (tabs: z.infer<typeof Tabs>) => tabs.tabs.flatMap((tab) => tab.sessionId ?? [])

let pendingProfiles: (() => Promise<void>)[] = []
afterEach(async () => {
  // Every write lands before the shared teardown removes the profile's folder.
  await chatTabCommandsSettled()
  for (const flush of pendingProfiles) {
    await flush()
  }
  pendingProfiles = []
  vi.unstubAllEnvs()
})

async function rig() {
  const opened = await openAuthorityRuntime(await authorityProfile([], { records: [B, C, O] }))
  pendingProfiles.push(() => opened.profile.flushPendingOrThrowAsync())
  opened.profile.saveBot(makeTestBot({ id: TEAMMATE.botId, folderWorkspaceId: opened.folderId }))
  for (const sessionId of [B, C]) {
    opened.runtime
      .getOrchestrationDb()
      .recordBotConversationActsFor(sessionId, { actsFor: [botShareAsker(SCOPE)] })
  }
  // The RPC server's share device store: the teammate's desktop and phone, nothing else.
  const devices: BotShareDevices = {
    teammateOfDevice: (deviceId) =>
      deviceId === 'mate-desk' || deviceId === 'mate-phone' ? TEAMMATE : null,
    isOwnerDevice: (deviceId) => deviceId.startsWith('owner-'),
    mintBotShareOffer: vi.fn(),
    revokeBotShareDevices: vi.fn(),
    provisionBotSharePhone: vi.fn(),
    revokeBotSharePhone: vi.fn(),
    getE2EEPublicKey: () => null,
    reachedAccounts: () => new Map(),
    deliverBotShareHeldMessage: vi.fn()
  }
  opened.runtime.botShareDevices = devices
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
      : { kind: 'runtime-paired' as const, grants: [] }
  })
  const call = async (deviceId: string, method: string, params: unknown) => {
    const reply = await dispatcher.dispatch(
      { id: `${method}-${randomUUID()}`, authToken: '', method, params },
      context(deviceId)
    )
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
    return reply.ok ? reply.result : undefined
  }
  const worktree = `id:${opened.workspace}`
  const list = async (deviceId: string) =>
    Tabs.parse(await call(deviceId, 'session.tabs.list', { worktree }))
  /** A device's live tab stream of the agent's home, frame by frame. */
  const subscribe = async (deviceId: string) => {
    const frames: z.infer<typeof Tabs>[] = []
    void dispatcher.dispatchStreamingObjects(
      {
        id: `sub-${deviceId}`,
        authToken: '',
        method: 'session.tabs.subscribe',
        params: { worktree }
      },
      (response) => {
        const frame = response.ok
          ? z.looseObject({ type: z.string() }).parse(response.result)
          : null
        if (frame && (frame.type === 'snapshot' || frame.type === 'updated')) {
          frames.push(Tabs.parse(frame))
        }
      },
      context(deviceId)
    )
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    return frames
  }
  return {
    ...opened,
    call,
    list,
    subscribe,
    host: opened.host,
    hostChats: async () =>
      (await opened.runtime.listMobileSessionTabs(opened.workspace)).tabs.flatMap((tab) =>
        tab.type === 'agent-session' ? [tab.sessionId] : []
      ),
    reveal: (deviceId: string, sessionId: string) =>
      call(deviceId, 'agentSession.reveal', { sessionId, navigation: 'caller' }),
    close: (deviceId: string, sessionId: string) =>
      call(deviceId, 'session.tabs.close', {
        worktree,
        tabId: `agent-session:${sessionId}`,
        reason: 'user'
      })
  }
}

it('opens a teammate’s chat in their own tabs and leaves the owner’s tab list unchanged', async () => {
  const r = await rig()
  await r.reveal('mate-desk', C)

  expect(await r.hostChats()).toEqual([])
  expect(savedIds(r)).toEqual([])
  expect(r.host.isSessionTabVisible(C)).toBe(false)
  expect(sessions(await r.list('owner-desk'))).toEqual([])
  // One person, every device of theirs.
  expect(sessions(await r.list('mate-desk'))).toEqual([C])
  expect(sessions(await r.list('mate-phone'))).toEqual([C])

  await r.close('mate-desk', C)
  expect(sessions(await r.list('mate-phone'))).toEqual([])
  expect(await r.hostChats()).toEqual([])
})

it('lists a teammate’s own tabs in listAll and subscribeAll with no host tab in the home', async () => {
  const r = await rig()
  // A windowless host (orca serve) answers the all-workspace census from main's own graph.
  r.runtime['restoreHeadlessGraphAuthority']()
  await r.reveal('mate-desk', C)

  const All = z.object({ snapshots: z.array(Tabs) })
  const listed = All.parse(await r.call('mate-phone', 'session.tabs.listAll', null))
  expect(listed.snapshots.filter((s) => s.worktree === r.workspace).map(sessions)).toEqual([[C]])

  const frames: z.infer<typeof All>[] = []
  const dispatcher = new RpcDispatcher({ runtime: r.runtime, methods: ALL_RPC_METHODS })
  void dispatcher.dispatchStreamingObjects(
    { id: 'all', authToken: '', method: 'session.tabs.subscribeAll', params: null },
    (response) => {
      const frame = response.ok ? z.looseObject({ type: z.string() }).parse(response.result) : null
      if (frame?.type === 'snapshots') {
        frames.push(All.parse(frame))
      }
    },
    {
      pairedDeviceId: 'mate-phone',
      connectionId: 'socket-all',
      clientKind: 'runtime',
      clientCapabilities: remoteRuntimeClientCapabilities(
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      ),
      callerScope: SCOPE
    }
  )
  await vi.waitFor(() => expect(frames).toHaveLength(1))
  expect(frames[0]!.snapshots.filter((s) => s.worktree === r.workspace).map(sessions)).toEqual([
    [C]
  ])
})

it('updates a teammate’s other device live, past its first empty frame', async () => {
  const r = await rig()
  const phone = await r.subscribe('mate-phone')
  const first = phone[0]!
  expect(sessions(first)).toEqual([])

  await r.reveal('mate-desk', C)
  await vi.waitFor(() => expect(phone.some((frame) => sessions(frame).includes(C))).toBe(true))
  const shown = phone.find((frame) => sessions(frame).includes(C))!
  // A desktop drops a frame that does not outrank the one it holds.
  expect(
    shown.publicationEpoch !== first.publicationEpoch ||
      shown.snapshotVersion > first.snapshotVersion
  ).toBe(true)
})

it('answers a teammate’s activate with their own tabs, never the owner’s', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)
  await r.reveal('mate-desk', C)
  expect(await r.hostChats()).toEqual([O])

  const reply = Tabs.parse(
    await r.call('mate-desk', 'session.tabs.activate', {
      worktree: `id:${r.workspace}`,
      tabId: `agent-session:${C}`,
      navigation: 'caller'
    })
  )
  expect(sessions(reply)).toEqual([C])
  expect(reply.activeTabId).toBe(`agent-session:${C}`)
})

it('does not snap back to a closed tab when the chat is opened again', async () => {
  const r = await rig()
  await r.reveal('mate-desk', B)
  await r.reveal('mate-desk', C)
  await r.call('mate-desk', 'session.tabs.activate', {
    worktree: `id:${r.workspace}`,
    tabId: `agent-session:${C}`,
    navigation: 'caller'
  })
  await r.close('mate-desk', C)
  expect((await r.list('mate-desk')).activeTabId).toBe(`agent-session:${B}`)

  // Opened again from their phone: the desktop stays where it was.
  await r.reveal('mate-phone', C)
  const desk = await r.list('mate-desk')
  expect(sessions(desk)).toEqual([B, C])
  expect(desk.activeTabId).toBe(`agent-session:${B}`)
})

it('puts a chat a teammate creates in the home in their own tabs, not the owner’s list', async () => {
  const r = await rig()
  // The agent's runtime home is made under the app's data folder: the test's own.
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  const sessionId = randomUUID()
  await r.call('mate-desk', 'agentSession.create', {
    envelope: {
      sessionId,
      clientOperationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
      expectedRuntimeFence: null,
      // As the client signs it.
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId,
        worktree: `id:${r.workspace}`,
        agent: 'codex'
      })
    },
    worktree: `id:${r.workspace}`,
    agent: 'codex'
  })
  expect(await r.hostChats()).toEqual([])
  expect(r.host.isSessionTabVisible(sessionId)).toBe(false)
  expect(sessions(await r.list('mate-phone'))).toEqual([sessionId])
})

it('still opens an owner’s paired screen’s chat in the host’s list, shared by all of them', async () => {
  const r = await rig()
  await r.reveal('owner-desk', O)

  expect(await r.hostChats()).toEqual([O])
  expect(r.host.isSessionTabVisible(O)).toBe(true)
  expect(sessions(await r.list('owner-phone'))).toEqual([O])
})

it('moves a teammate’s tab an older build saved in the host’s list into their own tabs, kept across a restart', async () => {
  const r = await rig()
  // What an older build did for a teammate: the paired-caller reveal into the host's list.
  await r.reveal('owner-phone', C)
  expect(await r.hostChats()).toEqual([C])

  const bot = { id: TEAMMATE.botId, folderWorkspaceId: r.folderId }
  await moveTeammateHostTabs(r.runtime, [bot], r.runtime['clientSessionTabSelections'].personTabs)
  expect(await r.hostChats()).toEqual([])
  expect(savedIds(r)).toEqual([])
  expect(sessions(await r.list('mate-phone'))).toEqual([C])
  expect(teammateTabSetKey(TEAMMATE) in r.profile.getMobileClientTabSelections()).toBe(true)

  // A restart: the saved selections read back into a fresh store.
  await r.profile.flushPendingOrThrowAsync()
  await closeTestStores()
  pendingProfiles = []
  const restarted = new ClientSessionTabSelectionStore()
  restarted.hydrate(createStore().getMobileClientTabSelections())
  restarted.personTabs.setPeople({
    personOf: (id) =>
      id === 'mate-desk'
        ? { key: teammateTabSetKey(TEAMMATE), home: r.workspace, hostTabs: (snapshot) => snapshot }
        : null,
    tabOf: () => ({ title: 'Home', agent: 'codex' })
  })
  const shown = restarted.project(await r.runtime.listMobileSessionTabs(r.workspace), 'mate-desk')
  expect(shown.tabs.map((tab) => tab.type === 'agent-session' && tab.sessionId)).toEqual([C])
})
