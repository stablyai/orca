import { describe, expect, it } from 'vitest'
import { AGENT_HOOK_SESSION_NONCE_ENV_VAR } from '../../shared/agent-hook-session-nonce'
import { AgentHookServer, _internals } from '../agent-hooks/server'
import { buildBody, PANE } from '../agent-hooks/server.test-fixtures'
import { classifyAdoptedCodexReadinessEvent } from './adopted-codex-tui-readiness'
import { getCodexManagedHookInstallMaterial } from './hook-service'

describe('Codex session-nonce hook wire', () => {
  it('posts the nonce env var back as a form field', () => {
    const { script } = getCodexManagedHookInstallMaterial()
    expect(script).toContain(`sessionNonce=`)
    expect(script).toContain(AGENT_HOOK_SESSION_NONCE_ENV_VAR)
  })

  it('keeps the nonce post fire-and-forget: no extra request, no extra wait', () => {
    const { script } = getCodexManagedHookInstallMaterial()
    // Why this is asserted at all: Codex blocks synchronously on hooks, so a second
    // POST or a longer budget for the nonce would stall every resume by seconds.
    expect(script.match(/-X POST/g)).toHaveLength(1)
    expect(script).not.toMatch(/--max-time "?[3-9]/)
  })

  it('carries the nonce from the form body onto the normalized event', () => {
    const event = _internals.normalizeHookPayload(
      'codex',
      buildBody(
        { hook_event_name: 'SessionStart', source: 'resume', session_id: 'thread-1' },
        { sessionNonce: 'nonce-1' }
      ),
      'production'
    )
    expect(event?.sessionNonce).toBe('nonce-1')
    expect(event?.hookEventName).toBe('SessionStart')
    expect(event?.providerSession?.id).toBe('thread-1')
  })

  it('delivers the nonce over the real hook endpoint to enriched-status subscribers', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const seen: unknown[] = []
    const unsubscribe = server.subscribeEnrichedStatus((event) => seen.push(event))
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody(
            { hook_event_name: 'SessionStart', source: 'resume', session_id: 'thread-1' },
            { sessionNonce: 'nonce-1' }
          )
        )
      })
      expect(response.status).toBe(204)
    } finally {
      unsubscribe()
      server.stop()
    }
    // The seam the runtime's readiness watch actually sits on: a SessionStart that
    // travelled the wire end to end must classify as proof.
    expect(seen).toHaveLength(1)
    expect(
      classifyAdoptedCodexReadinessEvent(seen[0] as never, {
        paneKey: PANE,
        threadId: 'thread-1',
        sessionNonce: 'nonce-1'
      })
    ).toBe('ready')
  })

  it('leaves the nonce undefined when an older installed script omits it', () => {
    const event = _internals.normalizeHookPayload(
      'codex',
      buildBody({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'thread-1' }),
      'production'
    )
    expect(event?.sessionNonce).toBeUndefined()
  })
})
