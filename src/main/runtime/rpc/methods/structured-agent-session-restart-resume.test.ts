// The restart-offer methods act for the calling client: a paired client too old to show an agent
// is never listed, resumed, dismissed, or answered that agent's offers. The host stub filters by the
// audience it is handed, as the real host does (structured-agent-session-restart-audience.test.ts).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  restartRowsFor,
  type StructuredAgentSessionRestartAudience
} from '../../../native-chat/agent-session-wire/structured-agent-session-restart-resume-set'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import {
  call,
  clearStructuredHostStub,
  hostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

afterEach(clearStructuredHostStub)

const CLAUDE_OFFER = { sessionId: 'claude-session', agent: 'claude' }
const GROK_OFFER = { sessionId: 'grok-session', agent: 'grok' }

// A desktop from before registered agents: every client that calls these methods advertises Claude
// support, and this one nothing beyond Claude and Codex.
const OLD_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES.filter(
    (capability) => capability !== STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}
const NEW_CLIENT = {
  ...OLD_CLIENT,
  clientCapabilities: [
    ...OLD_CLIENT.clientCapabilities,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
}

/** A host holding a Claude and a Grok offer, plus a recorded Grok failure. */
function installRestartHost() {
  let offers = [CLAUDE_OFFER, GROK_OFFER]
  const failures = [{ ...GROK_OFFER, reason: 'agent_session_resume_refused' }]
  const list = async (audience?: StructuredAgentSessionRestartAudience) =>
    restartRowsFor(offers, audience)
  const listFailures = async (audience?: StructuredAgentSessionRestartAudience) =>
    restartRowsFor(failures, audience)
  const restartResume = {
    list: vi.fn(list),
    listFailures: vi.fn(listFailures),
    dismiss: vi.fn(
      async (sessionIds?: readonly string[], audience?: StructuredAgentSessionRestartAudience) => {
        const gone = restartRowsFor(offers, audience).filter(
          (offer) => sessionIds?.includes(offer.sessionId) ?? true
        )
        offers = offers.filter((offer) => !gone.includes(offer))
        return gone.length
      }
    ),
    dismissListed: vi.fn(
      async (
        listed: readonly { sessionId: string }[],
        audience?: StructuredAgentSessionRestartAudience
      ) => {
        const named = new Set(listed.map((offer) => offer.sessionId))
        const gone = restartRowsFor(offers, audience).filter((offer) => named.has(offer.sessionId))
        offers = offers.filter((offer) => !gone.includes(offer))
        return gone.length
      }
    ),
    continueAfterRestart: vi.fn(
      async (
        _sessionIds: readonly string[] | undefined,
        _owner: string,
        audience?: StructuredAgentSessionRestartAudience
      ) => ({
        resumed: [],
        continued: [],
        sessions: await list(audience),
        failed: await listFailures(audience)
      })
    )
  }
  setStructuredAgentSessionHost(
    Object.assign(hostStub(), {
      restartResume,
      knownAgentIds: () => ['claude', 'codex', 'grok']
    })
  )
  return { restartResume, offers: () => offers }
}

describe("a paired client too old to show the host's other agents", () => {
  it('lists only the offers it can show', async () => {
    installRestartHost()
    expect(await call('agentSession.restartResumable', {}, OLD_CLIENT)).toMatchObject({
      ok: true,
      result: { sessions: [CLAUDE_OFFER], failed: [] }
    })
  })

  it('dismisses only the offers it was shown when it dismisses all', async () => {
    const host = installRestartHost()
    expect(await call('agentSession.restartResumableDismiss', {}, OLD_CLIENT)).toMatchObject({
      ok: true,
      result: { dismissed: 1, sessions: [], failed: [] }
    })
    expect(host.offers()).toEqual([GROK_OFFER])
  })

  it('cannot dismiss an offer it was not shown by naming it', async () => {
    const host = installRestartHost()
    expect(
      await call(
        'agentSession.restartResumableDismiss',
        { sessionIds: [GROK_OFFER.sessionId] },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: true, result: { dismissed: 0, sessions: [CLAUDE_OFFER], failed: [] } })
    expect(host.offers()).toEqual([CLAUDE_OFFER, GROK_OFFER])
  })

  it('cannot dismiss an offer it was not shown by listing it', async () => {
    const host = installRestartHost()
    const listed = [CLAUDE_OFFER, GROK_OFFER].map(({ sessionId }) => ({ sessionId, recordedAt: 1 }))
    expect(
      await call(
        'agentSession.restartResumableDismiss',
        { sessionIds: listed.map((offer) => offer.sessionId), offers: listed },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: true, result: { dismissed: 1, sessions: [], failed: [] } })
    expect(host.offers()).toEqual([GROK_OFFER])
  })

  it('hands the host its audience when it continues all, so hidden offers are not run', async () => {
    const host = installRestartHost()
    await call('agentSession.restartContinue', {}, OLD_CLIENT)
    const audience = host.restartResume.continueAfterRestart.mock.lastCall?.[2]
    expect(host.restartResume.continueAfterRestart.mock.lastCall?.[0]).toBeUndefined()
    expect(audience?.('claude')).toBe(true)
    expect(audience?.('codex')).toBe(true)
    expect(audience?.('grok')).toBe(false)
  })

  it('is not answered the hidden offers or failures after a named continuation', async () => {
    installRestartHost()
    expect(
      await call(
        'agentSession.restartContinue',
        { sessionIds: [CLAUDE_OFFER.sessionId] },
        OLD_CLIENT
      )
    ).toMatchObject({ ok: true, result: { sessions: [CLAUDE_OFFER], failed: [] } })
  })
})

describe.each([
  ["a paired client that shows the host's agents", NEW_CLIENT],
  ["the host's own process", undefined]
])('%s', (_label, client) => {
  it('acts on every offer', async () => {
    const host = installRestartHost()
    expect(await call('agentSession.restartResumable', {}, client)).toMatchObject({
      ok: true,
      result: { sessions: [CLAUDE_OFFER, GROK_OFFER], failed: [{ agent: 'grok' }] }
    })
    await call('agentSession.restartContinue', {}, client)
    expect(host.restartResume.continueAfterRestart.mock.lastCall?.[2]).toBeUndefined()
    await call('agentSession.restartResumableDismiss', {}, client)
    expect(host.restartResume.dismiss.mock.lastCall?.[1]).toBeUndefined()
    expect(host.offers()).toEqual([])
  })
})
