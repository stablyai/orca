import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  createClaudeAcquisitionAttempt,
  type ClaudeAcquireCallbacks,
  type ClaudeSession
} from '../claude-structured-session-state'
import { ClaudePromptRegistry } from '../permissions/claude-prompt-registry'
import { createClaudeInitProof } from '../startup/claude-structured-init-proof'
import { createClaudeSessionJournalTranslator } from './claude-structured-session-journal-control'

type Launch = Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'bypassDisabled'>

function launch(sessionId: string, session: Launch) {
  const bodies: AgentJournalItemBody[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => bodies.push(body),
    appendTombstone: () => {},
    publish: vi.fn()
  }
  const attempt = createClaudeAcquisitionAttempt(new ClaudePromptRegistry())
  attempt.published = true
  const translator = createClaudeSessionJournalTranslator(
    sink,
    '1',
    {
      attempt,
      initProof: createClaudeInitProof(),
      callbacks: {} as ClaudeAcquireCallbacks,
      sessionId
    },
    () => session as ClaudeSession,
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

const FULL_ACCESS = { permissionMode: 'bypassPermissions' }

describe('a Full access chat whose Claude refuses bypass', () => {
  it('gets one warning per chat, across turns and restarts', () => {
    const opened = { launchIntent: FULL_ACCESS, firstRootInit: { permissionMode: 'default' } }
    const first = launch('refused-chat', opened)
    first.init('default')
    first.init('default')
    expect(first.warnings()).toHaveLength(1)

    const restarted = launch('refused-chat', opened)
    restarted.init('default')
    expect(restarted.warnings()).toHaveLength(0)
  })

  it('is warned after a Plan start once Claude reports bypass turned off', () => {
    const planStart = launch('plan-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'plan' },
      bypassDisabled: true
    })
    planStart.init('plan')
    expect(planStart.warnings()).toHaveLength(1)
  })

  it('stays quiet when Claude allows Full access or the chat never asked for it', () => {
    const granted = launch('granted-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'bypassPermissions' }
    })
    granted.init('bypassPermissions')
    granted.init('default')
    const plan = launch('allowed-plan-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'plan' },
      bypassDisabled: false
    })
    plan.init('plan')
    const asked = launch('ask-chat', {
      launchIntent: { permissionMode: 'default' },
      firstRootInit: { permissionMode: 'default' }
    })
    asked.init('default')
    expect([...granted.warnings(), ...plan.warnings(), ...asked.warnings()]).toHaveLength(0)
  })
})
