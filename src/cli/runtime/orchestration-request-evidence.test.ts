import { describe, expect, it } from 'vitest'
import { OrchestrationRequestEvidence } from './orchestration-compatibility-envelope'

describe('terminal evidence on secret requests', () => {
  const SHELL = {
    ORCA_AGENT_SESSION_ID: '11111111-1111-4111-8111-111111111111',
    ORCA_TERMINAL_HANDLE: 'term_1',
    ORCA_PANE_KEY: 'tab:leaf',
    ORCA_AGENT_LAUNCH_TOKEN: 'tok'
  }

  it('sends the shell evidence (never the chat id) to this host so orcad can verify the caller', () => {
    const evidence = new OrchestrationRequestEvidence(SHELL)
    expect(
      evidence.envelopeFor('secrets.request', {
        remote: false,
        mutation: false,
        requestId: undefined
      })
    ).toEqual({
      orchestrationCompatibilityEvidence: {
        terminalHandle: 'term_1',
        paneKey: 'tab:leaf',
        launchToken: 'tok'
      }
    })
  })

  it('sends nothing to another server', () => {
    const evidence = new OrchestrationRequestEvidence(SHELL)
    expect(
      evidence.envelopeFor('secrets.request', {
        remote: true,
        mutation: false,
        requestId: undefined
      })
    ).toEqual({})
  })
})
