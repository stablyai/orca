import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  resolveSleepingPaneWakeTarget,
  type SleepingPaneWakeLookups
} from './sleeping-pane-wake-target'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function autoSleptRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    ...overrides
  }
}

function lookups(overrides: Partial<SleepingPaneWakeLookups> = {}): SleepingPaneWakeLookups {
  return {
    getRunCoordinatorPaneKey: () => undefined,
    getDispatchAssigneePaneKey: () => undefined,
    getPaneKeyForHandle: () => null,
    getSleepingRecord: () => undefined,
    ...overrides
  }
}

describe('resolveSleepingPaneWakeTarget', () => {
  it('resolves a run mailbox through its coordinator pane', () => {
    const resolution = resolveSleepingPaneWakeTarget(
      'run:run-1',
      lookups({
        getRunCoordinatorPaneKey: (runId) => (runId === 'run-1' ? PANE_KEY : undefined),
        getSleepingRecord: () => autoSleptRecord()
      })
    )
    expect(resolution).toEqual({
      ok: true,
      request: { paneKey: PANE_KEY, worktreeId: 'wt-1', tabId: 'tab-1' }
    })
  })

  it('resolves a dispatch mailbox through its assignee pane', () => {
    const resolution = resolveSleepingPaneWakeTarget(
      'dispatch:ctx-1',
      lookups({
        getDispatchAssigneePaneKey: (id) => (id === 'ctx-1' ? PANE_KEY : undefined),
        getSleepingRecord: () => autoSleptRecord()
      })
    )
    expect(resolution.ok).toBe(true)
  })

  it('resolves a bare terminal mailbox through its remembered pane', () => {
    const resolution = resolveSleepingPaneWakeTarget(
      'term_abc',
      lookups({
        getPaneKeyForHandle: (handle) => (handle === 'term_abc' ? PANE_KEY : null),
        getSleepingRecord: () => autoSleptRecord()
      })
    )
    expect(resolution.ok).toBe(true)
  })

  it('refuses when no pane identity survives', () => {
    expect(resolveSleepingPaneWakeTarget('run:run-1', lookups())).toEqual({
      ok: false,
      reason: 'no-pane-identity'
    })
  })

  it('refuses when the pane has no sleeping record', () => {
    expect(
      resolveSleepingPaneWakeTarget(
        'run:run-1',
        lookups({ getRunCoordinatorPaneKey: () => PANE_KEY })
      )
    ).toEqual({ ok: false, reason: 'not-slept' })
  })

  it.each([
    ['an explicit workspace sleep', { restoreOnTabOpenOnly: true }],
    ['a still-working manual sleep', { state: 'working' as const }],
    ['a quit capture', { origin: 'quit' as const }],
    ['a live resume anchor', { origin: 'live' as const }],
    ['an interrupted turn', { interrupted: true }],
    ['a fenced legacy worker', { automaticResumeBlockedBy: 'legacy-orchestration-worker' as const }]
  ])('never auto-wakes %s', (_label, overrides) => {
    expect(
      resolveSleepingPaneWakeTarget(
        'run:run-1',
        lookups({
          getRunCoordinatorPaneKey: () => PANE_KEY,
          getSleepingRecord: () => autoSleptRecord(overrides)
        })
      )
    ).toEqual({ ok: false, reason: 'user-slept' })
  })

  it('recovers the current tab from the pane key when persistence has no tab id', () => {
    const record = autoSleptRecord()
    delete record.tabId
    const resolution = resolveSleepingPaneWakeTarget(
      'run:run-1',
      lookups({ getRunCoordinatorPaneKey: () => PANE_KEY, getSleepingRecord: () => record })
    )
    expect(resolution).toEqual({
      ok: true,
      request: { paneKey: PANE_KEY, worktreeId: 'wt-1', tabId: 'tab-1' }
    })
  })

  it('uses the resolved reminted tab instead of a stale persisted tab id', () => {
    const remintedPaneKey = PANE_KEY.replace('tab-1', 'tab-reminted')
    const resolution = resolveSleepingPaneWakeTarget(
      'term_abc',
      lookups({
        getPaneKeyForHandle: () => remintedPaneKey,
        getSleepingRecord: () => autoSleptRecord({ tabId: 'tab-obsolete' })
      })
    )
    expect(resolution).toEqual({
      ok: true,
      request: { paneKey: remintedPaneKey, worktreeId: 'wt-1', tabId: 'tab-reminted' }
    })
  })

  it('refuses a sleeping record with no routable tab identity', () => {
    expect(
      resolveSleepingPaneWakeTarget(
        'term_abc',
        lookups({
          getPaneKeyForHandle: () => 'legacy-unparseable',
          getSleepingRecord: () => autoSleptRecord()
        })
      )
    ).toEqual({ ok: false, reason: 'no-tab-identity' })
  })
})
