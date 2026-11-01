import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from './rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './rpc/methods/structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_CLOSE_METHOD } from './rpc/methods/structured-agent-session-close-method'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/agent-session/agent-session-runtime-capabilities'
import {
  B,
  authorityProfile,
  openAuthorityRuntime,
  savedIds
} from './structured-agent-session-tab-authority.test-support'
import * as publication from './session-tabs/structured-session-tab-publication'
import { chatTabCommandsSettled } from './session-layout-apply.test-fixture'

vi.mock('../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))

it('does not resurrect a History tab when normal close commits before its publisher resumes', async () => {
  const rig = await openAuthorityRuntime(await authorityProfile([], { records: [B], visible: [] }))
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
