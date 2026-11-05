import { registerSessionHandlers } from '../../../ipc/session'
import {
  physicalReload,
  B,
  authorityProfile,
  openAuthorityRuntime,
  savedIds
} from './structured-agent-session-tab-authority.test-support'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
const { sessionHandlers } = vi.hoisted(() => ({
  sessionHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      sessionHandlers.set(channel, handler)
    ),
    on: vi.fn()
  }
}))
import '../../rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from '../../rpc/methods/structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_CLOSE_METHOD } from '../../rpc/methods/structured-agent-session-close-method'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'

import * as publication from '../../session-tabs/structured-session-tab-publication'
import { chatTabCommandsSettled } from '../../orca-runtime-tests/session-layout-apply.test-fixture'
import { mobileChatTabId } from '../agent-session-tab-identity'

vi.mock('../../../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

async function initializedRig() {
  const profile = await authorityProfile([], { records: [B], visible: [] })
  await profile.profile.executeWorkspaceSurfaceCommand({ type: 'initialize', hostId: 'local' })
  return openAuthorityRuntime(profile)
}

it('does not resurrect a History tab when normal close commits before its publisher resumes', async () => {
  const rig = await initializedRig()
  await rig.runtime.restoreStructuredAgentSessionTabs()
  const rpc = new RpcDispatcher({
    runtime: rig.runtime,
    methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
  })
  const events: string[] = []
  const admit = publication.admitStructuredSessionTabPublication
  vi.spyOn(publication, 'admitStructuredSessionTabPublication').mockImplementationOnce(
    async (...args) => {
      const admitted = await admit(...args)
      expect(rig.host.getSessionTabId(B)).toBe(admitted.tabId)
      expect(rig.host.hasSession(B)).toBe(true)
      events.push('show-committed')
      // Forward real SHOW and close effects; hold only the opener's continuation after its currency read.
      expect(
        await STRUCTURED_AGENT_SESSION_CLOSE_METHOD.handler(
          { sessionId: B },
          {
            runtime: rig.runtime,
            clientKind: 'mobile',
            clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
          }
        )
      ).toEqual({ ok: true })
      expect(rig.host.getSessionTabId(B)).toBeNull()
      events.push('close-committed')
      return admitted
    }
  )
  const reveal = await rpc.dispatch(
    {
      id: 'history-reveal',
      authToken: 'token',
      method: 'agentSession.reveal',
      params: { sessionId: B, navigation: 'caller' }
    },
    {
      pairedDeviceId: 'phone',
      clientKind: 'mobile',
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
  )
  events.push('opener-settled')
  await chatTabCommandsSettled()
  expect(events).toEqual(['show-committed', 'close-committed', 'opener-settled'])
  expect(rig.host.getSessionTabId(B)).toBeNull()
  expect(rig.runtime.currentLocalStructuredSessionPresentation(B)).toBeNull()
  expect(savedIds(rig)).toEqual([])
  expect(rig.host.listSessionTabs()).toEqual([])
  expect(rig.host.hasSession(B)).toBe(false)
  expect(rig.store.getRecord(B)?.lease).toMatchObject({
    claimStatus: 'released',
    ownerProcess: null,
    reservedSpawnToken: null
  })
  expect(rig.acquire).not.toHaveBeenCalled()
  expect(reveal).toMatchObject({ ok: false })
})

it.each(['caller', 'runtime'] as const)(
  'keeps a healthy %s reveal through the actual stale desktop session save before its publisher resumes',
  async (navigation) => {
    expect(ORCA_LAYOUT_OWNER_IS_MAIN).toBe(false)
    const rig = await initializedRig()
    await rig.runtime.restoreStructuredAgentSessionTabs()
    const stale = structuredClone(rig.profile.getWorkspaceSession())
    rig.runtime.attachWindow(1)
    rig.runtime.syncWindowGraph(1, { tabs: [], leaves: [], mobileSessionTabs: [] })
    const pushed: string[][] = []
    rig.runtime.onMobileSessionTabsChanged((rows) => pushed.push(rows.tabs.map((tab) => tab.id)))
    registerSessionHandlers(rig.profile, rig.runtime)
    const rpc = new RpcDispatcher({
      runtime: rig.runtime,
      methods: STRUCTURED_AGENT_SESSION_REVEAL_METHODS
    })
    const admit = publication.admitStructuredSessionTabPublication
    let exactTab = ''
    vi.spyOn(publication, 'admitStructuredSessionTabPublication').mockImplementationOnce(
      async (...args) => {
        const admitted = await admit(...args)
        exactTab = admitted.tabId
        expect(rig.host.getSessionTabId(B)).toBe(exactTab)
        await sessionHandlers.get('session:set')!({}, stale, 'local')
        await sessionHandlers.get('session:flush')!({})
        return admitted
      }
    )
    const reply = await rpc.dispatch(
      {
        id: 'healthy-history-reveal',
        authToken: 'token',
        method: 'agentSession.reveal',
        params: { sessionId: B, ...(navigation === 'caller' ? { navigation: 'caller' } : {}) }
      },
      {
        ...(navigation === 'caller' ? { pairedDeviceId: 'phone', clientKind: 'mobile' } : {}),
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )
    await chatTabCommandsSettled()
    await rig.profile.flushPendingOrThrowAsync()
    expect(reply).toMatchObject({ ok: true })
    expect(rig.host.getSessionTabId(B)).toBe(exactTab)
    expect(rig.host.hasSession(B)).toBe(true)
    const presentedTab = mobileChatTabId(B)
    expect(rig.runtime.currentLocalStructuredSessionPresentation(B)?.tabId).toBe(presentedTab)
    expect(rig.host.listSessionTabs().filter((tab) => tab.sessionId === B)).toHaveLength(1)
    expect(savedIds(rig)).toEqual([B])
    const listed = await rig.runtime.listMobileSessionTabs(`id:${rig.workspace}`)
    expect(listed.tabs.filter((tab) => tab.id === presentedTab)).toHaveLength(1)
    expect(pushed.some((ids) => ids.includes(presentedTab))).toBe(true)
    const reopened = await physicalReload(rig)
    expect(reopened.host.getSessionTabId(B)).toBe(exactTab)
    expect(savedIds(reopened)).toEqual([B])
  }
)
