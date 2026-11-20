import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpAdapterRig } from './testing/acp-structured-adapter.test-support'
import { antigravityTakesSystemPrompt } from '../launch/acp-instructions'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const RULES = { rules: 'You are Zorblax, a bot that runs in Orca.' }
const APPEND = {
  antigravity: { systemPrompt: { append: 'You are Zorblax, a bot that runs in Orca.' } }
}
const REOPEN = {
  sessionId: 'saved',
  key: 'saved-key',
  mayBeUnsaved: async () => false,
  lossKeys: []
}
const ADVERTISES_APPEND = {
  agentCapabilities: {
    loadSession: true,
    _meta: { antigravity: { systemPrompt: { append: true } } }
  }
}

describe('ACP standing instructions on the session', () => {
  it('sends them with a new session', async () => {
    const rig = await openAcpAdapterRig({ launch: { sessionMeta: RULES } })
    await rig.acquire()
    expect(rig.sent('session/new')[0]?.params).toEqual({
      cwd: '/workspace/project',
      mcpServers: [],
      _meta: RULES
    })
  })

  it('sends none on a reopen, which keeps the ones the conversation started with', async () => {
    const rig = await openAcpAdapterRig({
      launch: {
        sessionMeta: RULES,
        resume: REOPEN
      }
    })
    await rig.acquire({ fence: 2 })
    expect(rig.sent('session/load')[0]?.params).not.toHaveProperty('_meta')
    expect(rig.sent('session/new')).toEqual([])
  })

  it('sends them with the new session that replaces one the agent lost', async () => {
    const rig = await openAcpAdapterRig({
      launch: {
        sessionMeta: RULES,
        resume: {
          sessionId: 'lost',
          key: 'old-key',
          mayBeUnsaved: async () => true,
          lossKeys: []
        }
      },
      script: (agent) =>
        agent.on('session/load', (frame) => agent.fail(frame, -32002, 'Session not found'))
    })
    await rig.acquire({ fence: 2 })
    expect(rig.sent('session/new')[0]?.params).toMatchObject({ _meta: RULES })
  })

  it('sends them again on a reopen when the agent forgets them across its restarts', async () => {
    const rig = await openAcpAdapterRig({
      launch: { sessionMeta: APPEND, sessionMetaOnReopen: true, resume: REOPEN },
      initialize: ADVERTISES_APPEND
    })
    await rig.acquire({ fence: 2 })
    expect(rig.sent('session/load')[0]?.params).toMatchObject({ sessionId: 'saved', _meta: APPEND })
    expect(rig.sent('session/new')).toEqual([])
  })

  it('opens a session for them only when the agent advertises taking them', async () => {
    const launch = { sessionMeta: APPEND, takesSessionMeta: antigravityTakesSystemPrompt }
    const takes = await openAcpAdapterRig({ launch, initialize: ADVERTISES_APPEND })
    await takes.acquire()
    expect(takes.sent('session/new')[0]?.params).toMatchObject({ _meta: APPEND })

    const refuses = await openAcpAdapterRig({ launch })
    await refuses.acquire()
    expect(String(refuses.openFailure())).toMatch(/cannot take this chat's standing instructions/)
    expect(refuses.sent('session/new')).toEqual([])
  })
})

describe('ACP tools at a URL', () => {
  const docs = { type: 'http' as const, name: 'docs', url: 'https://docs.example/mcp', headers: [] }
  const files = { name: 'files', command: 'files-mcp', args: [], env: [] }

  it('sends them only to an agent that advertises taking them, and says why the rest are off', async () => {
    const takes = await openAcpAdapterRig({
      launch: { mcpServers: [docs, files] },
      initialize: { agentCapabilities: { mcpCapabilities: { http: true } } }
    })
    await takes.acquire()
    expect(takes.sent('session/new')[0]?.params).toMatchObject({ mcpServers: [docs, files] })

    const off: string[] = []
    const refuses = await openAcpAdapterRig({
      launch: { mcpServers: [docs, files], httpToolsOff: (reason) => off.push(reason) }
    })
    await refuses.acquire()
    expect(refuses.sent('session/new')[0]?.params).toMatchObject({ mcpServers: [files] })
    expect(off).toHaveLength(1)
    expect(off[0]).toMatch(/doesn't take tools at a URL/)
  })
})
