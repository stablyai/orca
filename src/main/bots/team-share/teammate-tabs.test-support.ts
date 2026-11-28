// The rig for a shared agent's people on one host: the owner's devices, two teammates' devices, through
// the real dispatcher, runtime, chat host and record store. Each test file calls `settleTeammateRig`
// after each test.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import {
  B,
  C,
  authorityProfile,
  openAuthorityRuntime,
  root,
  savedIds,
  type AuthorityRig
} from '../../runtime/agent-session/lifecycle/structured-agent-session-tab-authority.test-support'
import { chatTabCommandsSettled } from '../../runtime/terminal/layout/session-layout-apply.test-fixture'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import type { BotShareDevices } from './bot-share-access'
import type { TabListPerson } from './teammate-rules'
import { createSessionTabsTabDeltaDecoder } from '../../../shared/remote-runtime/session-graph/session-tabs-tab-delta'
import { botShareAsker } from './bot-share-chats'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime/remote-runtime-client-capabilities'
import { makeTestBot } from '../bot.test-fixture'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'

export { B, C }

export const TEAMMATE = { botId: 'bot-1', accountId: 'usr_mate' }
export const SCOPE: BotShareCallerScope = {
  kind: 'bot-share',
  ...TEAMMATE,
  workspaceTier: true
}
export const OTHER = { botId: 'bot-1', accountId: 'usr_other' }
// The owner's own chat in the agent's Home.
export const O = 'chat-o-0005'

export const Tabs = z.looseObject({
  worktree: z.string(),
  publicationEpoch: z.string(),
  snapshotVersion: z.number(),
  activeTabId: z.string().nullable(),
  tabs: z.array(z.looseObject({ id: z.string(), sessionId: z.string().optional() }))
})
export type Tabs = z.infer<typeof Tabs>
export const All = z.looseObject({ snapshots: z.array(Tabs) })
export const sessions = (tabs: Tabs) => tabs.tabs.flatMap((tab) => tab.sessionId ?? [])

// The open profile: a restart closes the one before it.
let profile: AuthorityRig['profile'] | null = null
let userData: string | null = null
export async function settleTeammateRig(): Promise<void> {
  // Every write lands before the shared teardown removes the profile's folder (#50219's CI flake).
  await chatTabCommandsSettled()
  await profile?.flushPendingOrThrowAsync()
  profile = null
  vi.unstubAllEnvs()
  // A started chat's agent home may still be written after the test; it is outside the profile's folder.
  if (userData) {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
    userData = null
  }
}

/** The app's data folder, where a started chat's agent home is made: the test's own. */
export function stubUserData(): void {
  userData ??= mkdtempSync(join(tmpdir(), 'orca-teammate-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
}

const share = (accountId: string, name: string) => ({
  kind: 'account' as const,
  shareId: `share-${accountId}`,
  accountId,
  name,
  email: `${accountId}@example.com`,
  addedAt: 1,
  acceptedAt: 1
})

export const SHARED = {
  shares: [share(TEAMMATE.accountId, 'Mate'), share(OTHER.accountId, 'Other')]
}

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
    deliverBotShareHeldMessage: vi.fn(),
    syncBotShareDeviceNames: vi.fn()
  }
}

/** `home`: which folder is the agent's Home; the rig's own workspace by default, else a second one
 *  (so the rig's workspace is one of the agent's workers' workspaces). */
export async function rig(options: { home?: 'rig' | 'other'; opened?: AuthorityRig } = {}) {
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
        ...SHARED
      })
    )
    for (const sessionId of [B, C]) {
      opened.runtime
        .getOrchestrationDb()
        .recordBotConversationActsFor(sessionId, { actsFor: [botShareAsker(SHARED, SCOPE)] })
    }
  }
  profile = opened.profile
  opened.runtime.botShareDevices = shareDevices()
  const dispatcher = new RpcDispatcher({ runtime: opened.runtime, methods: ALL_RPC_METHODS })
  /** `clientKind`: a desktop's by default; `mobile` as a phone's app calls. */
  const context = (deviceId: string, clientKind: 'runtime' | 'mobile' = 'runtime') => ({
    pairedDeviceId: deviceId,
    connectionId: `socket-${deviceId}`,
    clientKind,
    // As a desktop's handshake sends them.
    clientCapabilities: remoteRuntimeClientCapabilities(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    ),
    callerScope: deviceId.startsWith('mate-')
      ? SCOPE
      : deviceId.startsWith('other-')
        ? { ...SCOPE, ...OTHER }
        : { kind: 'runtime-paired' as const, grants: [] }
  })
  const send = (
    deviceId: string,
    method: string,
    params: unknown,
    clientKind?: 'runtime' | 'mobile'
  ) =>
    dispatcher.dispatch(
      { id: `${method}-${randomUUID()}`, authToken: '', method, params },
      context(deviceId, clientKind)
    )
  const call = async (
    deviceId: string,
    method: string,
    params: unknown,
    clientKind?: 'runtime' | 'mobile'
  ) => {
    const reply = await send(deviceId, method, params, clientKind)
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
    return reply.ok ? reply.result : undefined
  }
  const worktree = `id:${opened.workspace}`
  const home = folderWorkspaceKey(homeFolder)
  /** A device's list of a workspace: its own, or with `person` the list it watches. */
  const list = async (
    deviceId: string,
    where = worktree,
    person?: TabListPerson,
    clientKind?: 'runtime' | 'mobile'
  ) =>
    Tabs.parse(
      await call(
        deviceId,
        'session.tabs.list',
        { worktree: where, ...(person ? { person } : {}) },
        clientKind
      )
    )
  /** A device's live frames: one workspace's stream (its own list, or with `person` the list it
   *  watches), or with `all` its census stream. */
  const subscribe = async (
    deviceId: string,
    all = false,
    person?: TabListPerson,
    clientKind?: 'runtime' | 'mobile'
  ) => {
    const frames: Tabs[] = []
    // As a desktop reads its stream: a frame's tabs may come as a delta of the one before.
    const tabDelta = createSessionTabsTabDeltaDecoder()
    void dispatcher.dispatchStreamingObjects(
      {
        id: `sub-${deviceId}-${all}-${randomUUID()}`,
        authToken: '',
        method: all ? 'session.tabs.subscribeAll' : 'session.tabs.subscribe',
        params: all ? null : { worktree, ...(person ? { person } : {}) }
      },
      (response) => {
        const decoded = response.ok ? tabDelta.decode(response.result) : null
        const frame = decoded?.ok ? z.looseObject({ type: z.string() }).parse(decoded.result) : null
        if (frame?.type === 'snapshot' || frame?.type === 'updated') {
          frames.push(Tabs.parse(frame))
        }
        if (frame?.type === 'snapshots') {
          frames.push(...All.parse(frame).snapshots)
        }
      },
      context(deviceId, clientKind)
    )
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    return frames
  }
  /** A device's stream of any method, open while the test runs; its raw replies. */
  const stream = (deviceId: string, method: string, params: unknown) => {
    const replies: unknown[] = []
    void dispatcher.dispatchStreamingObjects(
      { id: `stream-${deviceId}-${randomUUID()}`, authToken: '', method, params },
      (response) => replies.push(response),
      context(deviceId)
    )
    return replies
  }
  const create = async (deviceId: string, where = worktree) => {
    // The agent's runtime home is made under the app's data folder: the test's own.
    stubUserData()
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
    stream,
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
    reveal: async (deviceId: string, sessionId: string) =>
      expect(
        await call(deviceId, 'agentSession.reveal', { sessionId, navigation: 'caller' })
      ).toMatchObject({ ok: true }),
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
