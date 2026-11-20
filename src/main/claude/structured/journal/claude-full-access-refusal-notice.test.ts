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
  let inits = 0
  const init = (permissionMode: string) =>
    translator?.handle({
      type: 'message',
      sessionId,
      message: {
        type: 'system',
        subtype: 'init',
        permissionMode,
        session_id: 'claude-session',
        uuid: `init-${permissionMode}-${(inits += 1)}`
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
  it('gets one warning per process once its fallback is applied, and a new one after a restart', () => {
    const opened = {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true
    }
    const first = launch('refused-chat', opened)
    first.init('default')
    expect(first.warnings()).toHaveLength(0)
    first.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    first.init('auto')
    first.init('auto')
    expect(first.warnings()).toHaveLength(1)

    // The first row may be far up the chat, so a restart repeats it at the bottom.
    const restarted = launch('refused-chat', opened, '1')
    restarted.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    restarted.init('auto')
    restarted.init('auto')
    expect(restarted.ids).toEqual([expect.stringMatching(/:settings:auto$/)])
    expect(restarted.ids[0]).not.toBe(first.ids[0])
  })

  it('names Approve for me in a new row when a restart finds the chat back in it', () => {
    const opened = {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true
    }
    const first = launch('recovered-chat', opened)
    first.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    first.init('auto')
    Object.assign(first.session, { autoUnsettled: { kind: 'time', retryAt: 0 } })
    first.session.appliedInputOptions.set('buildPermissionMode', 'default')
    first.init('default')

    const restarted = launch('recovered-chat', opened, '1')
    restarted.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    restarted.init('auto')
    expect(first.ids).not.toContain(restarted.ids[0])
    expect(restarted.warnings()).toEqual([
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses Approve for me instead."
      })
    ])
  })

  it('warns again each time Claude moves the chat to another mode', () => {
    const moved = launch('moved-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: true
    })
    const toAuto = () => {
      Object.assign(moved.session, { autoUnsettled: undefined })
      moved.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    }
    const toAskForNow = () => {
      Object.assign(moved.session, { autoUnsettled: { kind: 'time', retryAt: 0 } })
      moved.session.appliedInputOptions.set('buildPermissionMode', 'default')
    }
    toAuto()
    moved.init('auto')
    toAskForNow()
    moved.init('default')
    moved.status()
    toAuto()
    moved.init('auto')
    toAskForNow()
    moved.init('default')
    expect(moved.ids).toEqual([
      expect.stringMatching(/^full-access-refused:claude:[\w-]+:1:settings:auto$/),
      expect.stringMatching(/:2:settings:ask:auto-for-now$/),
      expect.stringMatching(/:3:settings:auto$/),
      expect.stringMatching(/:4:settings:ask:auto-for-now$/)
    ])
    // A repeated change is a new row where it happens, not a revision of the old one.
    expect(moved.ids[3]).not.toBe(moved.ids[1])
    expect(moved.warnings().slice(0, 2)).toEqual([
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode), so Claude uses Approve for me instead."
      }),
      expect.objectContaining({
        text: "Claude's settings turn off Full access (permissions.disableBypassPermissionsMode) and Approve for me isn't available right now, so Claude uses Ask for approval instead."
      })
    ])
  })

  it('does not blame the settings when only the start showed Claude left Full access', () => {
    const blocked = launch('blocked-chat', {
      launchIntent: FULL_ACCESS,
      firstRootInit: { permissionMode: 'default' },
      bypassDisabled: false
    })
    blocked.session.appliedInputOptions.set('buildPermissionMode', 'auto')
    blocked.status()
    expect(blocked.warnings()).toEqual([
      expect.objectContaining({
        text: "Claude didn't start this chat in Full access, so Claude uses Approve for me instead."
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
      bypassDisabled: true,
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
