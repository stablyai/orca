import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeAcquisitionAttempt } from '../claude-structured-session-state'
import type { ClaudeAcquireCallbacks } from '../claude-structured-session-state'
import { ClaudePromptRegistry } from '../permissions/claude-prompt-registry'
import { createClaudeInitProof } from '../startup/claude-structured-init-proof'
import { createClaudeSessionJournalTranslator } from './claude-structured-session-journal-control'

function launch(sessionId: string, fullAccess: boolean) {
  const bodies: AgentJournalItemBody[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => bodies.push(body),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  const attempt = createClaudeAcquisitionAttempt(new ClaudePromptRegistry())
  attempt.fullAccess = fullAccess
  const translator = createClaudeSessionJournalTranslator(
    sink,
    '1',
    {
      attempt,
      initProof: createClaudeInitProof(),
      callbacks: {} as ClaudeAcquireCallbacks,
      sessionId
    },
    () => null,
    () => false
  )
  const init = (permissionMode: string) =>
    translator?.handle({
      type: 'message',
      sessionId,
      message: {
        type: 'system',
        subtype: 'init',
        permissionMode,
        session_id: 'claude-session',
        uuid: `init-${permissionMode}`
      }
    })
  const warnings = () => bodies.filter((body) => body.kind === 'status' && body.tone === 'warning')
  return { init, warnings }
}

describe('a Full access launch Claude opened in another mode', () => {
  it('says once per chat which mode the chat runs in', () => {
    const first = launch('refused-chat', true)
    first.init('default')
    first.init('default')
    expect(first.warnings()).toEqual([
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so this chat runs with Ask for approval."
      })
    ])

    const restarted = launch('refused-chat', true)
    restarted.init('default')
    expect(restarted.warnings()).toEqual([])
  })

  it('stays quiet when Claude granted Full access or the chat never asked for it', () => {
    const granted = launch('granted-chat', true)
    granted.init('bypassPermissions')
    const asked = launch('ask-chat', false)
    asked.init('default')
    expect([...granted.warnings(), ...asked.warnings()]).toEqual([])
  })
})
