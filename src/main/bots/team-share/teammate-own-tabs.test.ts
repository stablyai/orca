// A teammate's opened chat is in their own tabs, on every device of theirs, and never in the host's
// tab list; the owner's own paired screens still share the host's list.
import { expect, it, vi } from 'vitest'
import {
  C,
  authorityProfile,
  openAuthorityRuntime,
  savedIds
} from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
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

const TEAMMATE = { botId: 'bot-1', accountId: 'usr_mate' }
const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  ...TEAMMATE,
  name: 'Mate',
  workspaceTier: true
}

async function rig() {
  return wire(await openAuthorityRuntime(await authorityProfile([], { records: [C] })))
}

function wire(opened: Awaited<ReturnType<typeof openAuthorityRuntime>>) {
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
  const call = async (deviceId: string, method: string, params: unknown, teammate: boolean) => {
    const reply = await dispatcher.dispatch(
      { id: `${method}-${deviceId}`, authToken: '', method, params },
      {
        pairedDeviceId: deviceId,
        clientKind: 'runtime',
        // As a desktop's handshake sends them.
        clientCapabilities: remoteRuntimeClientCapabilities(
          ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
        ),
        callerScope: teammate ? SCOPE : { kind: 'runtime-paired', grants: [] }
      }
    )
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
    return reply
  }
  const chats = async (deviceId?: string) =>
    (await opened.runtime.listMobileSessionTabs(opened.workspace, deviceId)).tabs.flatMap((tab) =>
      tab.type === 'agent-session' ? [tab.sessionId] : []
    )
  const reveal = (deviceId: string, teammate: boolean) =>
    call(deviceId, 'agentSession.reveal', { sessionId: C, navigation: 'caller' }, teammate)
  return { ...opened, call, chats, reveal }
}

it('opens a teammate’s chat in their own tabs and leaves the owner’s tab list unchanged', async () => {
  const r = await rig()
  await r.reveal('mate-desk', true)

  expect(await r.chats()).toEqual([])
  expect(savedIds(r)).toEqual([])
  expect(r.host.isSessionTabVisible(C)).toBe(false)
  expect(await r.chats('owner-desk')).toEqual([])
  // One person, every device of theirs.
  expect(await r.chats('mate-desk')).toEqual([C])
  expect(await r.chats('mate-phone')).toEqual([C])

  await r.call(
    'mate-desk',
    'session.tabs.close',
    { worktree: `id:${r.workspace}`, tabId: `agent-session:${C}`, reason: 'user' },
    true
  )
  expect(await r.chats('mate-phone')).toEqual([])
  expect(await r.chats()).toEqual([])
})

it('still opens an owner’s paired screen’s chat in the host’s list, shared by all of them', async () => {
  const r = await rig()
  await r.reveal('owner-desk', false)

  expect(await r.chats()).toEqual([C])
  expect(r.host.isSessionTabVisible(C)).toBe(true)
  expect(await r.chats('owner-phone')).toEqual([C])
  expect(await r.chats('mate-desk')).toEqual([C])
})

it('moves a teammate’s tab an older build saved in the host’s list into their own tabs, kept across a restart', async () => {
  const r = await rig()
  // What an older build did for a teammate: the paired-caller reveal into the host's list.
  r.runtime
    .getOrchestrationDb()
    .recordBotConversationActsFor(C, { actsFor: [botShareAsker(SCOPE)] })
  await r.reveal('owner-phone', false)
  expect(await r.chats()).toEqual([C])

  const bot = { id: TEAMMATE.botId, folderWorkspaceId: r.folderId }
  await moveTeammateHostTabs(r.runtime, [bot], r.runtime['clientSessionTabSelections'].personTabs)
  expect(await r.chats()).toEqual([])
  expect(savedIds(r)).toEqual([])
  expect(await r.chats('mate-phone')).toEqual([C])
  expect(teammateTabSetKey(TEAMMATE) in r.profile.getMobileClientTabSelections()).toBe(true)

  // A restart: the saved selections read back into a fresh store.
  r.profile.flushOrThrow()
  await closeTestStores()
  const restarted = new ClientSessionTabSelectionStore()
  restarted.hydrate(createStore().getMobileClientTabSelections())
  restarted.personTabs.setPeople({
    personOf: (id) => (id === 'mate-desk' ? teammateTabSetKey(TEAMMATE) : null),
    tabOf: () => ({ title: 'Home', agent: 'codex' })
  })
  const shown = restarted.project(await r.runtime.listMobileSessionTabs(r.workspace), 'mate-desk')
  expect(shown.tabs.map((tab) => tab.type === 'agent-session' && tab.sessionId)).toEqual([C])
})
