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

type Launch = Pick<ClaudeSession, 'launchIntent' | 'firstRootInit' | 'bypassDisabled'> & {
  running?: string
}

function launch(sessionId: string, facts: Launch) {
  const { running, ...rest } = facts
  const session = {
    ...rest,
    appliedInputOptions: new Map<string, string>(),
    reportedOptions: running === undefined ? {} : { reportedPermissionMode: running }
  }
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callbacks run only on a journal write failure, which this sink never reports.
      callbacks: {} as ClaudeAcquireCallbacks,
      sessionId
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the notice reads only the permission facts, applied options and reports the stub sets.
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
  return { init, warnings, session }
}

const FULL_ACCESS = { permissionMode: 'bypassPermissions' }

describe('a Full access chat whose Claude refuses bypass', () => {
  it('gets one warning per chat once its fallback is applied, across turns and restarts', () => {
    const opened = { launchIntent: FULL_ACCESS, firstRootInit: { permissionMode: 'default' } }
    const first = launch('refused-chat', opened)
    first.init('default')
    expect(first.warnings()).toHaveLength(0)
    first.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    first.init('auto')
    first.init('auto')
    expect(first.warnings()).toHaveLength(1)

    const restarted = launch('refused-chat', opened)
    restarted.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    restarted.init('auto')
    expect(restarted.warnings()).toHaveLength(0)
  })

  it('is warned after a Plan start once leaving Plan applied the fallback', () => {
    const planStart = launch('plan-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'plan' },
      bypassDisabled: true,
      running: 'plan'
    })
    planStart.init('plan')
    expect(planStart.warnings()).toHaveLength(0)
    planStart.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    planStart.init('auto')
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
