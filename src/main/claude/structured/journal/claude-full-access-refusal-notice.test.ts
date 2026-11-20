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

type Launch = Pick<
  ClaudeSession,
  'launchIntent' | 'firstRootInit' | 'bypassDisabled' | 'bypassRefusal' | 'autoUnsettled'
> & {
  running?: string
}

function launch(sessionId: string, facts: Launch, acquisition = '1') {
  const { running, ...rest } = facts
  const session = {
    ...rest,
    appliedInputOptions: new Map<string, string>(),
    reportedOptions: running === undefined ? {} : { reportedPermissionMode: running }
  }
  const bodies: AgentJournalItemBody[] = []
  const ids: string[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
      ids.push('clientMessageId' in identity ? identity.clientMessageId : '')
      bodies.push(body)
    },
    appendTombstone: () => {},
    publish: vi.fn()
  }
  const attempt = createClaudeAcquisitionAttempt(new ClaudePromptRegistry())
  attempt.published = true
  const translator = createClaudeSessionJournalTranslator(
    sink,
    acquisition,
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
  const status = () =>
    translator?.handle({
      type: 'message',
      sessionId,
      message: {
        type: 'system',
        subtype: 'status',
        status: null,
        session_id: 'claude-session',
        uuid: `status-${sessionId}`
      }
    })
  const warnings = () => bodies.filter((body) => body.kind === 'status' && body.tone === 'warning')
  return { init, status, warnings, ids, session }
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

    // A restart that finds the chat as it started writes the same journal row, not another.
    const restarted = launch('refused-chat', opened, '2')
    restarted.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    restarted.init('auto')
    restarted.init('auto')
    expect([...first.ids, ...restarted.ids]).toEqual([
      'full-access-refused:claude:settings:auto',
      'full-access-refused:claude:settings:auto'
    ])
  })

  it('warns again each time Claude moves the chat to another mode', () => {
    const moved = launch('moved-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'default' }
    })
    moved.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    moved.init('auto')
    Object.assign(moved.session, { autoUnsettled: { kind: 'time', retryAt: 0 } })
    moved.session.appliedInputOptions.set('buildPermissionMode', 'default')
    moved.status()
    moved.status()
    Object.assign(moved.session, { autoUnsettled: undefined })
    moved.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    moved.status()
    expect(moved.ids).toEqual([
      'full-access-refused:claude:settings:auto',
      'full-access-refused:claude:settings:auto->settings:ask:auto-for-now',
      'full-access-refused:claude:settings:ask:auto-for-now->settings:auto'
    ])
    expect(moved.warnings().slice(0, 2)).toEqual([
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses Approve for me instead."
      }),
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode) and Approve for me isn't available right now, so Claude uses Ask for approval instead."
      })
    ])
  })

  it('names why Claude can not run Full access when it is not its settings', () => {
    const restricted = launch('restricted-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'bypassPermissions' },
      bypassDisabled: true,
      bypassRefusal: 'restricted'
    })
    restricted.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    restricted.status()
    expect(restricted.warnings()).toEqual([
      expect.objectContaining({
        text: 'Claude does not allow Full access in restricted mode, so Claude uses Approve for me instead.'
      })
    ])
  })

  it('is warned after a Plan start once leaving Plan applied the fallback, within the turn', () => {
    const planStart = launch('plan-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'plan' },
      bypassDisabled: true,
      running: 'plan'
    })
    planStart.init('plan')
    expect(planStart.warnings()).toHaveLength(0)
    planStart.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    planStart.status()
    expect(planStart.warnings()).toHaveLength(1)
  })

  it('names Ask as for now while Claude refuses auto only for now', () => {
    const unsettled = launch('unsettled-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'default' },
      autoUnsettled: { kind: 'time', retryAt: 0 }
    })
    unsettled.session.appliedInputOptions.set('buildPermissionMode', 'default')
    unsettled.init('default')
    expect(unsettled.warnings()).toEqual([
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode) and Approve for me isn't available right now, so Claude uses Ask for approval instead."
      })
    ])
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
