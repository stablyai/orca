import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { launchTokenHash } from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { EnrichedAgentHookEventPayload } from '../../../../agent-hooks/server/server-types'
import { OrchestrationDb } from '../../db/orchestration-db'
import { captureDispatchNativeUsageIdentity } from './dispatch-native-usage-capture'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../../../terminal/identity/agent-status-observed-pane-identity'

const hash = launchTokenHash('launch')!
const binding = {
  dispatchId: 'dispatch',
  terminalHandle: 'terminal',
  processIncarnation: 'process'
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these hook fields.
const event = {
  paneKey: 'pane',
  connectionId: null,
  launchToken: 'launch',
  receivedAt: 1000,
  providerSession: { key: 'session_id', id: 'session-a' },
  payload: { state: 'working', prompt: '', agentType: 'grok' },
  observation: { origin: 'hook' }
} as EnrichedAgentHookEventPayload

describe('dispatch native usage hook capture', () => {
  const db = new OrchestrationDb(':memory:')
  afterEach(() => {
    db.db.exec('DELETE FROM dispatch_contexts')
    vi.restoreAllMocks()
  })
  afterAll(() => db.close())
  it('records a live matching hook, keeps it after release, and rejects stale or replayed evidence', () => {
    db.db
      .prepare(`INSERT INTO dispatch_contexts
      (id, task_id, assignee_pane_key, process_incarnation, host_scope, launch_token_hash)
      VALUES ('dispatch', 'task', 'pane', 'process', 'host', ?)`)
      .run(hash)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: capture only reads created_at.
    vi.spyOn(db, 'getWorkerDispatch').mockReturnValue({
      created_at: '1970-01-01T00:00:00Z'
    } as never)
    let session = {
      paneKey: 'pane',
      processIncarnation: 'process',
      connectionId: null,
      launchTokenHash: hash,
      agent: 'grok' as const,
      providerSession: { key: 'session_id' as const, id: 'session-a' },
      observedAt: 1000
    }
    const runtime = {
      getExistingOrchestrationDb: () => db,
      getExactWorkerProviderSession: () => session,
      getAgentStatusTerminalHandleForPaneKey: () => 'terminal',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: binding only reads dispatchId.
      getAgentStatusOrchestrationContextForPaneKey: () => ({ dispatchId: 'dispatch' }) as never,
      getTerminalProcessIncarnation: () => 'process'
    }
    const read = () => JSON.parse(db.getDispatchContextById('dispatch')!.native_usage_identity!)
    captureDispatchNativeUsageIdentity(runtime, { ...event, isReplay: true }, binding)
    captureDispatchNativeUsageIdentity(runtime, { ...event, launchToken: 'stale' }, binding)
    expect(db.getDispatchContextById('dispatch')!.native_usage_identity).toBeNull()
    recordObservedAgentStatusPaneIdentity(new AgentStatusObservedPaneIdentities(), event, runtime)
    expect(read()).toMatchObject({
      status: 'observed',
      agent: 'grok',
      sessionId: 'session-a',
      processIncarnation: 'process'
    })
    session = { ...session, providerSession: { ...session.providerSession, id: 'session-b' } }
    captureDispatchNativeUsageIdentity(
      runtime,
      { ...event, providerSession: { key: 'session_id', id: 'session-b' } },
      binding
    )
    expect(read()).toEqual({ status: 'unavailable', reason: 'session_changed_or_shared' })
    db.db.exec("UPDATE dispatch_contexts SET capability_revoked_at = 'now'")
    captureDispatchNativeUsageIdentity(runtime, event, binding)
    expect(read()).toEqual({ status: 'unavailable', reason: 'session_changed_or_shared' })
  })
})
