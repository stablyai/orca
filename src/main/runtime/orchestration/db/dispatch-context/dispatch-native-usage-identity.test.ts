import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  recordDispatchNativeUsageIdentity,
  type DispatchNativeUsageIdentityReceipt
} from './dispatch-native-usage-identity'

describe('dispatch native usage identity', () => {
  const db = new OrchestrationDb(':memory:')
  const receipt: DispatchNativeUsageIdentityReceipt = {
    status: 'observed',
    agent: 'codex',
    sessionId: 'session',
    paneKey: 'pane',
    processIncarnation: 'process',
    hostScope: 'host',
    launchTokenHash: 'hash',
    observedAt: 1
  }
  afterEach(() => db.db.exec('DELETE FROM dispatch_contexts'))
  afterAll(() => db.close())

  function insert(): void {
    db.db
      .prepare(`INSERT INTO dispatch_contexts
      (id, task_id, assignee_pane_key, process_incarnation, host_scope, launch_token_hash)
      VALUES ('dispatch', 'task', 'pane', 'process', 'host', 'hash')`)
      .run()
  }
  function stored(): string | null {
    return db.getDispatchContextById('dispatch')!.native_usage_identity
  }

  it('keeps the first observation and permanently marks a changed identity unavailable', () => {
    insert()
    expect(recordDispatchNativeUsageIdentity(db, 'dispatch', receipt)).toBe(true)
    const first = stored()
    expect(JSON.parse(first!)).toEqual(receipt)
    recordDispatchNativeUsageIdentity(db, 'dispatch', { ...receipt, observedAt: 2 })
    expect(stored()).toBe(first)
    recordDispatchNativeUsageIdentity(db, 'dispatch', { ...receipt, sessionId: 'other' })
    expect(JSON.parse(stored()!)).toEqual({
      status: 'unavailable',
      reason: 'session_changed_or_shared'
    })
    recordDispatchNativeUsageIdentity(db, 'dispatch', receipt)
    expect(JSON.parse(stored()!)).toEqual({
      status: 'unavailable',
      reason: 'session_changed_or_shared'
    })
  })

  it('rejects missing, stale and revoked authority without changing the receipt', () => {
    insert()
    for (const changed of [
      { paneKey: 'other' },
      { processIncarnation: 'other' },
      { hostScope: 'other' },
      { launchTokenHash: 'other' },
      { sessionId: '' }
    ]) {
      expect(recordDispatchNativeUsageIdentity(db, 'dispatch', { ...receipt, ...changed })).toBe(
        false
      )
      expect(stored()).toBeNull()
    }
    db.db.exec("UPDATE dispatch_contexts SET capability_revoked_at = 'now'")
    expect(recordDispatchNativeUsageIdentity(db, 'dispatch', receipt)).toBe(false)
    expect(stored()).toBeNull()
  })

  it('marks a newly authorized process as ambiguous', () => {
    insert()
    recordDispatchNativeUsageIdentity(db, 'dispatch', receipt)
    db.db.exec("UPDATE dispatch_contexts SET process_incarnation = 'new-process'")
    expect(recordDispatchNativeUsageIdentity(db, 'dispatch', receipt)).toBe(false)
    recordDispatchNativeUsageIdentity(db, 'dispatch', {
      ...receipt,
      processIncarnation: 'new-process'
    })
    expect(JSON.parse(stored()!)).toEqual({
      status: 'unavailable',
      reason: 'session_changed_or_shared'
    })
  })
  it('marks a changed agent as ambiguous', () => {
    insert()
    recordDispatchNativeUsageIdentity(db, 'dispatch', receipt)
    recordDispatchNativeUsageIdentity(db, 'dispatch', { ...receipt, agent: 'other' })
    expect(JSON.parse(stored()!)).toEqual({
      status: 'unavailable',
      reason: 'session_changed_or_shared'
    })
  })
})
