import { describe, expect, it, vi } from 'vitest'
import {
  legacyAgentSessionRecordV1,
  LEGACY_AGENT_SESSION_ID
} from '../../../shared/agent-session-record-legacy.test-fixture'
import { loadAgentSessionRecord } from '../../../shared/agent-session-record-load'
import { isResumableStructuredAgentSessionRecord } from './structured-agent-session-resume-eligibility'
import { restoreStructuredAgentSessionsOnRestart } from './structured-agent-session-restart-restore'

describe('legacy structured session restart', () => {
  it('does not auto-attach an upgraded v1 record', async () => {
    const loaded = loadAgentSessionRecord(legacyAgentSessionRecordV1())
    if (loaded.status !== 'upgraded') {
      throw new Error(`expected upgrade, got ${loaded.status}`)
    }
    const serialize = vi.fn(async <T>(_sessionId: string, task: () => Promise<T>) => task())

    await restoreStructuredAgentSessionsOnRestart({
      store: { getRecord: () => loaded.record } as never,
      journalRoot: '/isolated/no-journal',
      records: [loaded.record],
      reconcile: async () => null,
      resolveRecovery: async () => 'not-applicable',
      serialize: serialize as never,
      hasSession: () => false,
      onReadable: vi.fn(),
      restoreHandoff: vi.fn(async () => undefined)
    })

    expect(loaded.record).toMatchObject({
      sessionId: LEGACY_AGENT_SESSION_ID,
      lease: { claimStatus: 'conflicted', handoffStage: 'manual-recovery' }
    })
    // Restart no longer resumes ANYTHING, so the guard that matters now is the one a surface hits:
    // a conflicted record under manual recovery is not a record a hold may acquire.
    expect(isResumableStructuredAgentSessionRecord(loaded.record)).toBe(false)
  })
})
