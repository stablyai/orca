import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchTokenHash } from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { EnrichedAgentHookEventPayload } from '../../../../agent-hooks/server/server-types'
import { OrchestrationDb } from '../../db/orchestration-db'
import {
  captureDispatchNativeUsageIdentity,
  settleDispatchNativeUsageIntervalAtRelease
} from './dispatch-native-usage-capture'
import { exposeNativeUsageIdentity } from '../../../rpc/methods/orchestration/worker/observation/dispatch-context-exposure'

const hash = launchTokenHash('launch')!
const binding = {
  dispatchId: 'dispatch',
  terminalHandle: 'terminal',
  processIncarnation: 'process'
}
const SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const LAUNCH = Date.parse('2026-01-01T00:00:00Z')

describe('dispatch native usage exclusive interval', () => {
  const db = new OrchestrationDb(':memory:')
  let dir: string
  let transcript: string
  let session: Record<string, unknown>
  const runtime = () => ({
    getExistingOrchestrationDb: () => db,
    getExactWorkerProviderSession: () => session as never
  })
  const line = (timestamp: string, extra = {}) => `${JSON.stringify({ timestamp, ...extra })}\n`
  const event = (overrides: Partial<EnrichedAgentHookEventPayload> = {}) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture reads only these fields.
    ({
      paneKey: 'pane',
      connectionId: null,
      launchToken: 'launch',
      receivedAt: 1000,
      providerSession: { key: 'session_id', id: SESSION },
      payload: { state: 'working', prompt: '', agentType: 'claude' },
      observation: { origin: 'hook' },
      ...overrides
    }) as EnrichedAgentHookEventPayload
  const interval = () => exposeNativeUsageIdentity(db.getDispatchContextById('dispatch')!)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'native-interval-'))
    transcript = join(dir, `${SESSION}.jsonl`)
    // Real fixture time keeps birthtime after LAUNCH.
    db.db
      .prepare(`INSERT INTO dispatch_contexts
      (id, task_id, assignee_pane_key, process_incarnation, host_scope, launch_token_hash)
      VALUES ('dispatch', 'task', 'pane', 'process', 'host', ?)`)
      .run(hash)
    vi.spyOn(db, 'getWorkerDispatch').mockReturnValue({
      created_at: new Date(LAUNCH).toISOString()
    } as never)
    session = {
      paneKey: 'pane',
      processIncarnation: 'process',
      connectionId: null,
      launchTokenHash: hash,
      agent: 'claude',
      providerSession: { key: 'session_id', id: SESSION, transcriptPath: transcript },
      observedAt: 1000
    }
  })
  afterEach(() => {
    db.db.exec('DELETE FROM dispatch_contexts')
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })
  afterAll(() => db.close())

  const release = () =>
    settleDispatchNativeUsageIntervalAtRelease(runtime(), db, 'dispatch', 'terminal', LAUNCH)

  it('closes a fresh session at the last complete line and keeps that outcome on repeat release', () => {
    writeFileSync(transcript, line('2026-06-01T00:00:00Z'))
    captureDispatchNativeUsageIdentity(runtime(), event(), binding)
    const complete = line('2026-06-01T00:00:01Z', { usage: 5 })
    appendFileSync(transcript, `${complete}{"timestamp":"2026-06-01T00:00:02Z"`)
    release()
    const first = interval()
    expect(first).toMatchObject({
      usageInterval: {
        status: 'closed',
        startOffset: 0,
        endOffset: line('2026-06-01T00:00:00Z').length + complete.length
      }
    })
    appendFileSync(transcript, line('2026-06-01T00:00:03Z'))
    release()
    expect(interval()).toEqual(first)
  })

  it('closes when the transcript is first created after the observation', () => {
    captureDispatchNativeUsageIdentity(runtime(), event(), binding)
    writeFileSync(transcript, line('2026-06-01T00:00:00Z'))
    release()
    expect(interval()).toMatchObject({ usageInterval: { status: 'closed', endOffset: 37 } })
  })

  it('is unavailable for a resumed session whose file carries pre-launch history', () => {
    writeFileSync(transcript, line('2025-12-31T00:00:00Z') + line('2026-06-01T00:00:00Z'))
    captureDispatchNativeUsageIdentity(runtime(), event(), binding)
    release()
    expect(interval()).toMatchObject({
      usageInterval: { status: 'unavailable', reason: 'not_fresh_session' }
    })
  })

  it('is unavailable when the session changed before release', () => {
    writeFileSync(transcript, line('2026-06-01T00:00:00Z'))
    captureDispatchNativeUsageIdentity(runtime(), event(), binding)
    session = {
      ...session,
      providerSession: { key: 'session_id', id: 'other', transcriptPath: transcript }
    }
    release()
    expect(interval()).toMatchObject({
      usageInterval: { status: 'unavailable', reason: 'session_changed' }
    })
  })

  it('is unavailable when another dispatch holds the same session', () => {
    writeFileSync(transcript, line('2026-06-01T00:00:00Z'))
    captureDispatchNativeUsageIdentity(runtime(), event(), binding)
    db.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, task_id, native_usage_identity) VALUES ('rival', 'task', ?)`
      )
      .run(JSON.stringify({ status: 'observed', agent: 'claude', sessionId: SESSION }))
    release()
    expect(interval()).toMatchObject({
      usageInterval: { status: 'unavailable', reason: 'session_shared' }
    })
  })

  it('is unavailable without a start boundary: no transcript path, or release without capture', () => {
    session = { ...session, providerSession: { key: 'session_id', id: SESSION } }
    captureDispatchNativeUsageIdentity(runtime(), event(), binding)
    release()
    expect(interval()).toMatchObject({
      usageInterval: { status: 'unavailable', reason: 'start_boundary_missing' }
    })
    db.db.exec(
      `UPDATE dispatch_contexts SET native_usage_identity = json_remove(native_usage_identity, '$.interval')`
    )
    release()
    expect(interval()).toMatchObject({
      usageInterval: { status: 'unavailable', reason: 'start_boundary_missing' }
    })
  })

  it('does not start an interval from replayed, remote or unsupported-agent hooks', () => {
    writeFileSync(transcript, line('2026-06-01T00:00:00Z'))
    captureDispatchNativeUsageIdentity(runtime(), event({ isReplay: true }), binding)
    expect(db.getDispatchContextById('dispatch')!.native_usage_identity).toBeNull()
    session = { ...session, connectionId: 'ssh-1' }
    captureDispatchNativeUsageIdentity(runtime(), event({ connectionId: 'ssh-1' }), binding)
    release()
    expect(interval()).toMatchObject({
      usageInterval: { status: 'unavailable', reason: 'host_not_local' }
    })
  })
})
