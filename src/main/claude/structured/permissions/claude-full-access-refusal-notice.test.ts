import { setImmediate } from 'node:timers/promises'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { ClaudeSlashCommandCatalog } from '../../command-catalog/claude-slash-command-catalog'
import { runClaudeControl } from '../../sdk-transport/claude-agent-sdk-control-requests'
import type { ClaudeSession } from '../claude-structured-session-state'
import { ClaudeJournalBoundDelivery } from '../journal/claude-journal-bound-delivery'
import { applyClaudeMessageOptions } from '../launch/claude-structured-message-options'
import { createClaudeInitProof } from '../startup/claude-structured-init-proof'
import { openClaudeSession } from '../startup/claude-structured-session-startup'
import {
  claimClaudeFullAccessRefusalNotice,
  journalClaudeSessionPermissionNotice,
  readClaudeEarlierRefusalNotice
} from './claude-full-access-refusal-notice'
import { claudeOwesPermissionFallback } from './claude-full-access-refusal'
import {
  observeClaudeRootInit,
  setClaudeAllowedPermissionMode
} from './claude-permission-mode-ladder'
import {
  claudeBuildPermissionMode,
  leaveClaudePlanModeOnApproval
} from './claude-plan-approval-mode'

it('sorts permission notice IDs across a base-36 digit boundary', () => {
  const clock = vi.spyOn(Date, 'now')
  const noticeAt = (time: number) => {
    clock.mockReturnValue(time)
    return claimClaudeFullAccessRefusalNotice({
      launchIntent: { permissionMode: 'auto' },
      autoDisabled: true,
      appliedInputOptions: new Map([['buildPermissionMode', 'default']]),
      fullAccessRefusalNotices: { process: 'process', count: 0 }
    })!.id
  }
  try {
    const before = noticeAt(36 ** 8 - 1)
    const after = noticeAt(36 ** 8)
    expect(before).toMatch(/^t00zzzzzzzz:/)
    expect(after).toMatch(/^t0100000000:/)
    expect([after, before].sort()).toEqual([before, after])
  } finally {
    clock.mockRestore()
  }
})

it('keeps one Ask warning across a repeated refusal and records a later auto recovery', async () => {
  const appliedInputOptions = new Map([['model', 'first-model']])
  const session = {
    launchIntent: { permissionMode: 'auto' },
    reportedOptions: {},
    appliedInputOptions,
    fullAccessRefusalNotices: { process: 'process', count: 0 },
    connection: {
      setPermissionMode: (mode: PermissionMode) =>
        runClaudeControl(
          'set_permission_mode',
          async () => {
            if (mode === 'auto' && appliedInputOptions.get('model') !== 'supported') {
              throw Object.assign(new Error('Model cannot use auto'), {
                errorClass: 'control_request_failed',
                errorCode: 'auto_mode_model'
              })
            }
          },
          null
        )
    }
  }
  const applyBuildMode = async () => {
    const mode = await setClaudeAllowedPermissionMode(session, claudeBuildPermissionMode(session))
    if (mode !== undefined) {
      appliedInputOptions.set('buildPermissionMode', mode)
    }
    return mode
  }

  expect(await applyBuildMode()).toBe('default')
  expect(claimClaudeFullAccessRefusalNotice(session)?.id).toMatch(/:auto-for-now:ask$/)
  expect(claudeOwesPermissionFallback(session)).toBe(false)

  appliedInputOptions.set('model', 'second-model')
  expect(claudeOwesPermissionFallback(session)).toBe(true)
  expect(await applyBuildMode()).toBe('default')
  expect(claimClaudeFullAccessRefusalNotice(session)).toBeNull()
  expect(claudeOwesPermissionFallback(session)).toBe(false)

  appliedInputOptions.set('model', 'supported')
  expect(claudeOwesPermissionFallback(session)).toBe(true)
  expect(await applyBuildMode()).toBe('auto')
  expect(claimClaudeFullAccessRefusalNotice(session)?.id).toMatch(/:restored:auto$/)
  expect(claimClaudeFullAccessRefusalNotice(session)).toBeNull()
})

function autoSession(setPermissionMode: (mode: PermissionMode) => Promise<void>): {
  session: ClaudeSession
  rows: string[]
} {
  const rows: string[] = []
  const session = {
    launchIntent: { permissionMode: 'auto' },
    reportedOptions: {},
    appliedInputOptions: new Map(),
    options: new Map(),
    confirmedOptions: new Set(),
    capabilities: [],
    commands: new ClaudeSlashCommandCatalog(),
    delivery: new ClaudeJournalBoundDelivery(),
    fullAccessRefusalNotices: { process: 'process', count: 0 },
    connection: { setPermissionMode },
    events: {
      appendItem: ({ clientMessageId }: { clientMessageId: string }) => rows.push(clientMessageId),
      publish: () => {}
    }
  } as unknown as ClaudeSession
  return { session, rows }
}

it('keeps the newer Plan request when an older Auto acknowledgement arrives', async () => {
  const acknowledged = Promise.withResolvers<void>()
  const { session, rows } = autoSession(async (mode) => {
    if (mode === 'auto') {
      await acknowledged.promise
    }
  })
  session.reportedOptions.reportedPermissionMode = 'plan'
  session.autoUnsettled = { kind: 'time', retryAt: 0 }
  session.fullAccessRefusalNoticeId = 'auto-for-now:ask'
  session.appliedInputOptions.set('buildPermissionMode', 'default')

  leaveClaudePlanModeOnApproval(session, { toolName: 'ExitPlanMode' }, { behavior: 'allow' })
  await applyClaudeMessageOptions(session, { interactionMode: 'plan' }, undefined)
  acknowledged.resolve()
  await setImmediate()

  expect(session.appliedInputOptions.get('interactionMode')).toBe('plan')
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(session.autoAccepted).toBeUndefined()
  expect(session.autoDisabled).toBeUndefined()
  expect(session.autoUnsettled).toEqual({ kind: 'time', retryAt: 0 })
  expect(rows).toEqual([])
})

it.each([
  { rootMode: undefined, mode: 'auto', notice: /:restored:auto$/ },
  { rootMode: 'default', mode: 'default', notice: /:auto-started-outside:ask$/ }
])('uses $mode on open with root init $rootMode', async ({ rootMode, mode, notice }) => {
  const { session, rows } = autoSession(async () => {})
  session.fullAccessRefusalNoticeId = 'earlier-process'
  if (rootMode) {
    observeClaudeRootInit(session, { permissionMode: rootMode })
  }
  await openClaudeSession({
    session,
    facts: Promise.resolve({
      init: null,
      initProof: createClaudeInitProof(),
      initialization: { current_permission_mode: 'auto' },
      resumesTranscript: true,
      requestTimeoutMs: undefined
    }),
    readSettings: () => new Promise<never>(() => {}),
    isCurrent: () => true,
    diagnose: () => {},
    onLateRefusal: () => {},
    report: () => {}
  })
  journalClaudeSessionPermissionNotice(session)

  expect(session.firstRootInit?.permissionMode).toBe(mode)
  expect(rows).toEqual([expect.stringMatching(notice)])
})

it('records Ask after an acknowledged fallback from a tagged Auto error', async () => {
  const askStarted = Promise.withResolvers<void>()
  const askAcknowledged = Promise.withResolvers<void>()
  const { session, rows } = autoSession((mode) =>
    runClaudeControl(
      'set_permission_mode',
      async () => {
        if (mode === 'auto') {
          throw Object.assign(new Error('Internal error'), {
            errorClass: 'control_request_failed',
            errorCode: 'internal_error'
          })
        }
        askStarted.resolve()
        await askAcknowledged.promise
      },
      null
    )
  )
  session.reportedOptions.reportedPermissionMode = 'ask'
  const build = applyClaudeMessageOptions(session, { interactionMode: 'default' }, undefined)
  await Promise.race([askStarted.promise, build])
  expect(rows).toEqual([])

  askAcknowledged.resolve()
  await build
  expect(session.appliedInputOptions.get('buildPermissionMode')).toBe('default')
  expect(rows).toEqual([expect.stringMatching(/:auto-for-now:ask$/)])
})

it('keeps an Ask warning when Plan approval settles after delivery retires', async () => {
  const acknowledged = Promise.withResolvers<void>()
  const { session, rows } = autoSession(() => acknowledged.promise)
  session.reportedOptions.reportedPermissionMode = 'plan'
  session.fullAccessRefusalNoticeId = 'auto-for-now:ask'

  leaveClaudePlanModeOnApproval(session, { toolName: 'ExitPlanMode' }, { behavior: 'allow' })
  session.delivery.dispose()
  acknowledged.resolve()
  await setImmediate()

  expect(session.fullAccessRefusalNoticeId).toBe('auto-for-now:ask')
  expect(rows).toEqual([])
})

it('recovers the earlier Ask warning after a transient reader failure', async () => {
  const itemId = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: 'full-access-refused:claude:t0000000001:earlier:1:settings:ask'
  })
  const session = {
    launchIntent: { permissionMode: 'bypassPermissions' },
    firstRootInit: { permissionMode: 'bypassPermissions' },
    delivery: new ClaudeJournalBoundDelivery()
  }
  const newestItemId = vi
    .fn()
    .mockRejectedValueOnce(new Error('Reader exited'))
    .mockResolvedValue({ itemId, greatestTimedId: itemId })

  await readClaudeEarlierRefusalNotice(session, { newestItemId }, () => {})

  expect(claimClaudeFullAccessRefusalNotice(session)?.id).toMatch(/:restored:bypassPermissions$/)
})
