import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../pty-process-table-parser'
import {
  buildOrphanProcessTree,
  collectProtectedAncestry,
  descendantsOf
} from './daemon-orphan-process-tree'
import { planOrphanReap, type OrphanReapPlanInput } from './daemon-orphan-reap-plan'
import { ptyOwnershipRecordKey, type PtyOwnershipRecord } from './pty-ownership-record'

const NOW = Date.parse('Mon Sep 21 12:00:00 2026')
const ROOT_STARTED_AT = 'Mon Sep 21 09:00:00 2026'
const AFTER_ROOT = 'Mon Sep 21 09:00:05 2026'
const LATER = 'Mon Sep 21 11:00:00 2026'
const SELF_STARTED_AT_MS = Date.parse('Mon Sep 21 11:30:00 2026')

// Defaults describe a leftover: reparented to init, in its own group, started after the root.
function row(overrides: Partial<ProcessTableRow> & { pid: number }): ProcessTableRow {
  return { ppid: 1, pgid: overrides.pid, startedAt: AFTER_ROOT, ...overrides }
}

function record(overrides: Partial<PtyOwnershipRecord> = {}): PtyOwnershipRecord {
  return {
    sessionId: 'session-a',
    incarnationId: 'inc-1',
    root: { pid: 500, startedAt: ROOT_STARTED_AT },
    processes: [],
    pgids: [500],
    tty: 'ttys004',
    // The reconciler never correlates on tty; it is carried for the per-session sweeps, which can
    // afford a `ps -t` selection that a whole-host capture cannot.
    daemon: { pid: 400, startedAtMs: Date.parse('Mon Sep 21 08:59:00 2026') },
    recordedAt: NOW - 10 * 60_000,
    ...overrides
  }
}

function plan(overrides: Partial<OrphanReapPlanInput> = {}) {
  return planOrphanReap({
    records: [record()],
    liveSessions: [],
    table: [],
    capturedAtMs: NOW,
    selfPid: 900,
    selfStartedAtMs: SELF_STARTED_AT_MS,
    pendingConfirmations: new Set<string>(),
    nowMs: NOW,
    spawnGraceMs: 60_000,
    maxRecordAgeMs: 24 * 60 * 60_000,
    daemonStartToleranceMs: 5_000,
    ...overrides
  })
}

const KEY = ptyOwnershipRecordKey('session-a', 'inc-1')
const CONFIRMED = new Set([KEY])
const SURVIVOR = { pid: 601, startedAt: AFTER_ROOT }

describe('planOrphanReap', () => {
  it('records the live tree as exact identities and prunes groups that no longer exist', () => {
    const result = plan({
      records: [record({ pgids: [500, 777] })],
      liveSessions: [{ sessionId: 'session-a', incarnationId: 'inc-1', pid: 500 }],
      table: [
        row({ pid: 500, ppid: 900, pgid: 500, startedAt: ROOT_STARTED_AT }),
        row({ pid: 601, ppid: 500, pgid: 601 }),
        row({ pid: 602, ppid: 601, pgid: 601 }),
        // Born in the capture's own second: indistinguishable from a same-second reuse.
        row({ pid: 603, ppid: 500, pgid: 500, startedAt: 'Mon Sep 21 12:00:00 2026' })
      ]
    })

    expect(result.reap).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['live_session'])
    expect(result.refreshed[0].processes).toEqual([
      { pid: 601, startedAt: AFTER_ROOT },
      { pid: 602, startedAt: AFTER_ROOT }
    ])
    expect([...result.refreshed[0].pgids].sort()).toEqual([500, 601])
    expect(result.refreshed[0].recordedAt).toBe(NOW)
  })

  it('completes a missing root start time only from the pid the host names for that generation', () => {
    const table = [row({ pid: 500, ppid: 900, pgid: 500, startedAt: ROOT_STARTED_AT })]
    const unproven = record({ root: { pid: 500, startedAt: null } })

    const adopted = plan({
      records: [unproven],
      liveSessions: [{ sessionId: 'session-a', incarnationId: 'inc-1', pid: 500 }],
      table
    })
    expect(adopted.refreshed[0].root).toEqual({ pid: 500, startedAt: ROOT_STARTED_AT })

    const elsewhere = plan({
      records: [unproven],
      liveSessions: [{ sessionId: 'session-a', incarnationId: 'inc-1', pid: 510 }],
      table
    })
    expect(elsewhere.refreshed[0].root).toEqual({ pid: 500, startedAt: null })
    expect(elsewhere.refreshed[0].processes).toEqual([])
  })

  it('protects every generation of a session whose live generation is unreported', () => {
    const result = plan({
      records: [record({ incarnationId: 'inc-1' }), record({ incarnationId: 'inc-2' })],
      // An older protocol can report a live session without naming its generation.
      liveSessions: [{ sessionId: 'session-a' }],
      table: [row({ pid: 500, startedAt: ROOT_STARTED_AT })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['live_session', 'live_session'])
  })

  it('requires two consecutive observations before signalling a stranded root', () => {
    const table = [
      row({ pid: 500, pgid: 500, startedAt: ROOT_STARTED_AT }),
      row({ pid: 601, ppid: 500, pgid: 500 })
    ]

    const first = plan({ table })
    expect(first.reap).toEqual([])
    expect(first.confirmNext).toEqual([KEY])
    expect(first.skipped.map((entry) => entry.reason)).toEqual(['awaiting_second_observation'])

    const second = plan({ table, pendingConfirmations: CONFIRMED })
    expect(second.reap).toHaveLength(1)
    expect(second.reap[0].reason).toBe('stranded_root')
    expect(second.reap[0].members.map((member) => member.pid).sort()).toEqual([500, 601])
    // Kept pending so a kill that does not land is retried rather than restarting the clock.
    expect(second.confirmNext).toEqual([KEY])
  })

  it('reaps a recorded descendant, and what it spawned, after the root is gone', () => {
    const result = plan({
      records: [record({ processes: [SURVIVOR] })],
      table: [row({ pid: 601, pgid: 500 }), row({ pid: 602, ppid: 601, pgid: 500 })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toHaveLength(1)
    expect(result.reap[0].reason).toBe('orphaned_descendant')
    expect(result.reap[0].members.map((member) => member.pid).sort()).toEqual([601, 602])
  })

  it('never signals an unrelated init-parented process that reused a recorded group', () => {
    // The root is gone and nothing recorded survives; a launchd app now leads group 500.
    const result = plan({
      table: [row({ pid: 601, ppid: 1, pgid: 500, startedAt: LATER })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.dropped).toEqual([{ key: KEY, sessionId: 'session-a', reason: 'settled' }])
  })

  it('never signals a live session root that reused a recorded group', () => {
    const result = plan({
      records: [record({ pgids: [500, 520] })],
      liveSessions: [{ sessionId: 'session-b', incarnationId: 'inc-9', pid: 520 }],
      // The daemon's own new shell, parented by the daemon, leading the reused group 520.
      table: [
        row({ pid: 520, ppid: 900, pgid: 520, startedAt: LATER }),
        row({ pid: 521, ppid: 520, pgid: 520, startedAt: LATER })
      ],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
  })

  it('never signals a recorded identity now inside a live session tree', () => {
    const result = plan({
      records: [record({ processes: [SURVIVOR] })],
      liveSessions: [{ sessionId: 'session-b', incarnationId: 'inc-9', pid: 520 }],
      table: [
        row({ pid: 520, ppid: 900, pgid: 520, startedAt: LATER }),
        row({ pid: 601, ppid: 520, pgid: 520 })
      ],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['protected_process'])
  })

  it('never signals a reused root pid when the root start time was never captured', () => {
    const result = plan({
      records: [record({ root: { pid: 500, startedAt: null } })],
      table: [row({ pid: 500, ppid: 1, pgid: 500, startedAt: LATER })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.dropped).toEqual([{ key: KEY, sessionId: 'session-a', reason: 'unprovable' }])
  })

  it('never signals a root or descendant pid live under a different start time', () => {
    const result = plan({
      records: [record({ processes: [SURVIVOR] })],
      table: [
        row({ pid: 500, pgid: 500, startedAt: LATER }),
        row({ pid: 601, pgid: 601, startedAt: LATER })
      ],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.dropped).toEqual([{ key: KEY, sessionId: 'session-a', reason: 'unprovable' }])
  })

  it('counts, but never signals, group members that match no recorded identity', () => {
    const result = plan({
      table: [
        row({ pid: 500, pgid: 500, startedAt: ROOT_STARTED_AT }),
        row({ pid: 700, ppid: 1, pgid: 500 })
      ],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap[0].members.map((member) => member.pid)).toEqual([500])
    expect(result.reap[0].unverifiedGroupMembers).toBe(1)
  })

  it('never signals a recorded identity in the daemon own ancestry', () => {
    const result = plan({
      records: [record({ processes: [{ pid: 800, startedAt: AFTER_ROOT }] })],
      // 900 is the daemon; 800 is its parent.
      table: [row({ pid: 900, ppid: 800, pgid: 800 }), row({ pid: 800, pgid: 800 })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['protected_process'])
  })

  it('leaves another live daemon records alone', () => {
    const result = plan({
      table: [
        row({ pid: 400, pgid: 400, startedAt: 'Mon Sep 21 08:59:00 2026' }),
        row({ pid: 500, pgid: 500, startedAt: ROOT_STARTED_AT })
      ],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['owning_daemon_alive'])
  })

  it('holds off on a record younger than the spawn grace', () => {
    const result = plan({
      records: [record({ recordedAt: NOW - 5_000 })],
      table: [row({ pid: 500, pgid: 500, startedAt: ROOT_STARTED_AT })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual(['within_spawn_grace'])
  })

  it('retires a record whose recorded pids are all gone', () => {
    const result = plan({
      records: [record({ processes: [SURVIVOR] })],
      table: [row({ pid: 999, pgid: 999 })]
    })

    expect(result.dropped).toEqual([{ key: KEY, sessionId: 'session-a', reason: 'settled' }])
    expect(result.confirmNext).toEqual([])
  })

  it('expires a record that outlived its bounded age even while processes remain', () => {
    const result = plan({
      records: [record({ recordedAt: NOW - 25 * 60 * 60_000 })],
      table: [row({ pid: 500, pgid: 500, startedAt: ROOT_STARTED_AT })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.dropped).toEqual([{ key: KEY, sessionId: 'session-a', reason: 'expired' }])
  })

  it('keys records by incarnation so a respawn does not inherit the previous generation debt', () => {
    const result = plan({
      records: [
        record({ incarnationId: 'inc-1', processes: [SURVIVOR] }),
        record({ incarnationId: 'inc-2', root: { pid: 510, startedAt: LATER } })
      ],
      liveSessions: [{ sessionId: 'session-a', incarnationId: 'inc-2', pid: 510 }],
      table: [
        row({ pid: 510, ppid: 900, pgid: 510, startedAt: LATER }),
        row({ pid: 601, pgid: 500 })
      ],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap.map((target) => target.incarnationId)).toEqual(['inc-1'])
    expect(result.refreshed.map((entry) => entry.incarnationId)).toEqual(['inc-2'])
  })

  it('never reaps what a session left behind when the daemon that ran it is still this one', () => {
    // `nohup server & exit`: the shell exits, the daemon tears the session down and keeps
    // running, and the recorded server survives reparented to init.
    const result = plan({
      records: [
        record({
          root: { pid: 500, startedAt: ROOT_STARTED_AT },
          processes: [SURVIVOR],
          daemon: { pid: 900, startedAtMs: SELF_STARTED_AT_MS }
        })
      ],
      table: [row({ pid: 601, ppid: 1, pgid: 601 })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap).toEqual([])
    expect(result.confirmNext).toEqual([])
    expect(result.dropped.map((entry) => entry.reason)).toEqual(['session_ended'])
  })

  it('still reaps for an earlier daemon that happened to hold the same pid', () => {
    const result = plan({
      records: [
        record({
          processes: [SURVIVOR],
          daemon: { pid: 900, startedAtMs: SELF_STARTED_AT_MS - 10 * 60 * 60_000 }
        })
      ],
      table: [row({ pid: 601, ppid: 1, pgid: 601 })],
      pendingConfirmations: CONFIRMED
    })

    expect(result.reap.map((target) => target.reason)).toEqual(['orphaned_descendant'])
  })
})

describe('descendantsOf', () => {
  it('terminates on a cycle and grants no children to a root listed twice', () => {
    const cyclic = buildOrphanProcessTree([
      row({ pid: 500, ppid: 1 }),
      row({ pid: 601, ppid: 602 }),
      row({ pid: 602, ppid: 601 }),
      row({ pid: 603, ppid: 500 })
    ])
    expect(descendantsOf(cyclic, 601).map((entry) => entry.pid)).toEqual([602])

    const duplicated = buildOrphanProcessTree([
      row({ pid: 500, ppid: 1 }),
      row({ pid: 500, ppid: 1, startedAt: LATER }),
      row({ pid: 603, ppid: 500 })
    ])
    expect(descendantsOf(duplicated, 500)).toEqual([])
  })
})

describe('collectProtectedAncestry', () => {
  it('walks the parent chain and collects every group along it', () => {
    const table = [
      row({ pid: 900, ppid: 800, pgid: 890 }),
      row({ pid: 800, ppid: 700, pgid: 800 }),
      row({ pid: 700, pgid: 700 })
    ]

    const protectedAncestry = collectProtectedAncestry(buildOrphanProcessTree(table), 900)

    expect([...protectedAncestry.pids].sort()).toEqual([700, 800, 900])
    expect([...protectedAncestry.pgids].sort()).toEqual([0, 1, 700, 800, 890])
  })

  it('terminates on a parent cycle a non-atomic capture can produce', () => {
    const table = [row({ pid: 900, ppid: 800 }), row({ pid: 800, ppid: 900 })]

    expect([...collectProtectedAncestry(buildOrphanProcessTree(table), 900).pids].sort()).toEqual([
      800, 900
    ])
  })
})
