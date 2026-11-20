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

  it('keeps folder instructions in place only while a new session opens, never for a reopen', async () => {
    const events: string[] = []
    let sentNew = (): number => 0
    const aroundNewSession = async (cwd: string) => {
      events.push(`placed in ${cwd} before ${sentNew()} new`)
      return async () => {
        events.push(`removed after ${sentNew()} new`)
      }
    }
    const fresh = await openAcpAdapterRig({ launch: { aroundNewSession } })
    sentNew = () => fresh.sent('session/new').length
    await fresh.acquire()
    expect(events).toEqual(['placed in /workspace/project before 0 new', 'removed after 1 new'])

    events.length = 0
    const reopened = await openAcpAdapterRig({ launch: { aroundNewSession, resume: REOPEN } })
    sentNew = () => reopened.sent('session/new').length
    await reopened.acquire({ fence: 2 })
    expect(events).toEqual([])
  })
})
